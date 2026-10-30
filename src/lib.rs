//! Allowance: a sandboxed treasury for AI agents on NEAR.
//!
//! A human owner funds this contract, writes a spending policy on-chain and
//! registers agents as **function-call access keys on the vault account
//! itself**. The protocol limits what such a key can do (only `pay`,
//! `confirm_delivery` and `ping` on this contract, within a gas allowance,
//! never attaching deposits); the contract limits how much money moves, to
//! whom and when. Every payment, rejection and approval leaves a receipt and a
//! NEP-297 event. Payments are in NEAR or in a NEP-141 fungible token (one
//! asset per agent policy); the vault keeps its own per-asset accounting.
//!
//! Trust model: the owner is `owner_id` (checked on `predecessor_account_id`),
//! never "whoever holds a key on this account". Agents are identified by
//! their key (`signer_account_pk`) when they call from the vault account, or
//! by their own account otherwise.

pub mod events;
pub mod policy;
pub mod types;

use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, PublicKey, env, ext_contract, near, require, serde_json,
};

use events::Event;
use policy::{Asset, Decision, EvalContext, NS_PER_SEC, PayRequest, Policy, Rejection, evaluate};
use types::{
    Agent, AgentId, AgentView, Failure, PayOutcome, Pending, PingResponse, Receipt, ReceiptKind,
    ReceiptStatus, Simulation, TokenAccount, TokenView, VaultInfo, Verdict,
};

/// Methods an agent key may call. Everything else is refused by the protocol
/// before the contract runs.
pub const AGENT_METHODS: &str = "pay,confirm_delivery,ping";
/// Gas allowance given to an agent key unless the owner overrides it. Gas is
/// charged at the buy price and refunded, so this is a ceiling, not a cost.
pub const DEFAULT_KEY_GAS_ALLOWANCE: NearToken = NearToken::from_near(1);
/// Default lifetime of an approval request.
pub const DEFAULT_APPROVAL_TTL_NS: u64 = 24 * 3_600 * NS_PER_SEC;
/// Smallest accepted deposit: covers the storage of its own receipt.
pub const MIN_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// Longest memo an agent may attach (bytes).
pub const MAX_MEMO_BYTES: usize = 256;
/// Longest agent label (bytes).
pub const MAX_LABEL_BYTES: usize = 64;
/// Balance kept on top of the storage stake so that the next receipt can
/// always be written.
pub const STORAGE_HEADROOM: NearToken = NearToken::from_millinear(10);
/// Length of `request_hash`.
pub const REQUEST_HASH_BYTES: usize = 32;
const GAS_FOR_PAY_CALLBACK: Gas = Gas::from_tgas(10);
const GAS_FOR_KEY_CALLBACK: Gas = Gas::from_tgas(5);
/// NEP-145 `storage_balance_of` on the token (a read).
const GAS_FOR_FT_STORAGE_CHECK: Gas = Gas::from_tgas(5);
/// NEP-145 `storage_deposit` on the token.
const GAS_FOR_FT_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
/// NEP-141 `ft_transfer` on the token.
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
/// `on_ft_storage_checked`: its own work plus the storage deposit, the
/// transfer and the settlement callback it schedules.
const GAS_FOR_FT_STEP: Gas = Gas::from_tgas(50);
/// NEP-141 requires exactly one yoctoNEAR on `ft_transfer`.
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Longest promise result read from a token contract (defensive bound).
const MAX_TOKEN_RESULT_BYTES: usize = 1_024;
const DEFAULT_PAGE: u64 = 50;

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Agents,
    Denylist,
    Receipts,
    Pending,
    Tokens,
}

/// The NEP-141 / NEP-145 methods the vault calls on a token contract.
#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
    fn storage_balance_of(&self, account_id: AccountId);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner_id: AccountId,
    approver_id: Option<AccountId>,
    paused: bool,
    key_gas_allowance: NearToken,
    approval_ttl_ns: u64,
    agents: IterableMap<AgentId, Agent>,
    denylist: IterableSet<AccountId>,
    receipts: LookupMap<u64, Receipt>,
    next_receipt_id: u64,
    first_receipt_id: u64,
    pending: IterableMap<u64, Pending>,
    next_pending_id: u64,
    /// NEP-141 tokens the owner registered, with the vault's own accounting.
    tokens: IterableMap<AccountId, TokenAccount>,
}

#[near]
impl Vault {
    /// Deploy-time initializer.
    ///
    /// * `owner_id` - the only account that may manage the vault.
    /// * `approver_id` - optional second account allowed to approve/deny
    ///   queued payments (a person or a DAO).
    /// * `approval_ttl_ns` - how long a queued payment waits (default 24h).
    /// * `key_gas_allowance` - gas allowance for agent keys (default 1 NEAR).
    #[init]
    pub fn new(
        owner_id: AccountId,
        approver_id: Option<AccountId>,
        approval_ttl_ns: Option<U64>,
        key_gas_allowance: Option<NearToken>,
    ) -> Self {
        let key_gas_allowance = key_gas_allowance.unwrap_or(DEFAULT_KEY_GAS_ALLOWANCE);
        require!(
            !key_gas_allowance.is_zero(),
            "key_gas_allowance must be > 0"
        );
        let approval_ttl_ns = approval_ttl_ns
            .map(|t| t.0)
            .unwrap_or(DEFAULT_APPROVAL_TTL_NS);
        require!(approval_ttl_ns > 0, "approval_ttl_ns must be > 0");
        Self {
            owner_id,
            approver_id,
            paused: false,
            key_gas_allowance,
            approval_ttl_ns,
            agents: IterableMap::new(StorageKey::Agents),
            denylist: IterableSet::new(StorageKey::Denylist),
            receipts: LookupMap::new(StorageKey::Receipts),
            next_receipt_id: 0,
            first_receipt_id: 0,
            pending: IterableMap::new(StorageKey::Pending),
            next_pending_id: 0,
            tokens: IterableMap::new(StorageKey::Tokens),
        }
    }

    // ------------------------------------------------------------------
    // Funding
    // ------------------------------------------------------------------

    /// Fund the vault. Anyone may deposit; the deposit is recorded as an
    /// `income` receipt. Returns the receipt id.
    #[payable]
    pub fn deposit(&mut self) -> u64 {
        let amount = env::attached_deposit();
        require!(
            amount >= MIN_DEPOSIT,
            "deposit at least 0.01 NEAR (covers the receipt's storage)"
        );
        let from = env::predecessor_account_id();
        let receipt_id = self.push_receipt(Receipt {
            id: 0,
            kind: ReceiptKind::Income,
            status: ReceiptStatus::Paid,
            agent: AgentId::Account(from.clone()),
            payee: env::current_account_id(),
            amount,
            asset: Asset::Near,
            memo: String::new(),
            request_hash: None,
            ts_ns: U64(env::block_timestamp()),
            policy_version: 0,
            delivered: None,
            pending_id: None,
            approved_by: None,
            storage_deposit: None,
        });
        Event::VaultFunded {
            from,
            amount,
            asset: Asset::Near,
            receipt_id,
        }
        .emit();
        receipt_id
    }

    /// Owner: move funds out of the vault (to the owner unless `to` is given).
    /// The storage reserve can never be withdrawn.
    pub fn withdraw(&mut self, amount: NearToken, to: Option<AccountId>) -> Promise {
        self.assert_owner();
        require!(!amount.is_zero(), "amount must be > 0");
        let available = self.available_balance();
        require!(
            amount <= available,
            "amount exceeds the balance available above the storage reserve"
        );
        let to = to.unwrap_or_else(|| self.owner_id.clone());
        let receipt_id = self.push_receipt(Receipt {
            id: 0,
            kind: ReceiptKind::Refund,
            status: ReceiptStatus::Paid,
            agent: AgentId::Account(self.owner_id.clone()),
            payee: to.clone(),
            amount,
            asset: Asset::Near,
            memo: String::new(),
            request_hash: None,
            ts_ns: U64(env::block_timestamp()),
            policy_version: 0,
            delivered: None,
            pending_id: None,
            approved_by: None,
            storage_deposit: None,
        });
        Event::Withdrawn {
            to: to.clone(),
            amount,
            asset: Asset::Near,
            receipt_id,
        }
        .emit();
        Promise::new(to).transfer(amount)
    }

    // ------------------------------------------------------------------
    // NEP-141 tokens
    // ------------------------------------------------------------------

    /// Owner: accept a NEP-141 token. Agents may only be given token policies
    /// for registered tokens, and the vault only credits `ft_transfer_call`s
    /// from registered tokens (others are refunded by the token).
    /// `min_deposit` (base units, default 1) refuses dust deposits.
    ///
    /// The vault must also have storage on the token to receive it: attach
    /// NEAR (e.g. 0.00125 for the reference implementation) and the vault
    /// registers itself with `storage_deposit(registration_only)`; or pay the
    /// registration from any account beforehand.
    #[payable]
    pub fn register_token(&mut self, token_id: AccountId, min_deposit: Option<U128>) {
        self.assert_owner();
        let min_deposit = min_deposit.map(|m| m.0).unwrap_or(1);
        require!(min_deposit > 0, "min_deposit must be > 0");
        match self.tokens.get_mut(&token_id) {
            Some(token) => token.min_deposit = min_deposit,
            None => {
                self.tokens.insert(
                    token_id.clone(),
                    TokenAccount {
                        balance: 0,
                        min_deposit,
                    },
                );
            }
        }
        let attached = env::attached_deposit();
        if !attached.is_zero() {
            ext_ft::ext(token_id.clone())
                .with_attached_deposit(attached)
                .with_static_gas(GAS_FOR_FT_STORAGE_DEPOSIT)
                .storage_deposit(Some(env::current_account_id()), Some(true))
                .detach();
        }
        Event::TokenRegistered {
            token_id,
            min_deposit: U128(min_deposit),
        }
        .emit();
    }

    /// NEP-141 receiver: tokens sent with `ft_transfer_call` fund the vault.
    /// Registered tokens are credited and recorded as an `income` receipt
    /// (`msg` becomes the memo); anything else is handed back to the token,
    /// which refunds the sender.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token_id = env::predecessor_account_id();
        let Some(min_deposit) = self.tokens.get(&token_id).map(|t| t.min_deposit) else {
            env::log_str(&format!(
                "ft_on_transfer: {token_id} is not a token registered with this vault; refunding"
            ));
            return PromiseOrValue::Value(amount);
        };
        if amount.0 < min_deposit {
            env::log_str("ft_on_transfer: below the token's min_deposit; refunding");
            return PromiseOrValue::Value(amount);
        }
        self.ft_credit(&token_id, amount.0);
        let asset = Asset::Ft(token_id);
        let receipt_id = self.push_receipt(Receipt {
            id: 0,
            kind: ReceiptKind::Income,
            status: ReceiptStatus::Paid,
            agent: AgentId::Account(sender_id.clone()),
            payee: env::current_account_id(),
            amount: NearToken::from_yoctonear(amount.0),
            asset: asset.clone(),
            memo: truncate_utf8(&msg, MAX_MEMO_BYTES),
            request_hash: None,
            ts_ns: U64(env::block_timestamp()),
            policy_version: 0,
            delivered: None,
            pending_id: None,
            approved_by: None,
            storage_deposit: None,
        });
        Event::VaultFunded {
            from: sender_id,
            amount: NearToken::from_yoctonear(amount.0),
            asset,
            receipt_id,
        }
        .emit();
        PromiseOrValue::Value(U128(0))
    }

    /// Owner: move tokens out of the vault (to the owner unless `to` is
    /// given; `to` must be registered on the token). Recorded as a `refund`
    /// receipt that settles as `paid`, or `failed` with the tokens credited
    /// back.
    pub fn withdraw_ft(
        &mut self,
        token_id: AccountId,
        amount: U128,
        to: Option<AccountId>,
    ) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0, "amount must be > 0");
        let balance = self
            .tokens
            .get(&token_id)
            .map(|t| t.balance)
            .unwrap_or_else(|| env::panic_str("token not registered"));
        require!(
            amount.0 <= balance,
            "amount exceeds the vault's token balance"
        );
        let to = to.unwrap_or_else(|| self.owner_id.clone());
        self.ft_debit(&token_id, amount.0);
        let receipt_id = self.push_receipt(Receipt {
            id: 0,
            kind: ReceiptKind::Refund,
            status: ReceiptStatus::Pending,
            agent: AgentId::Account(self.owner_id.clone()),
            payee: to.clone(),
            amount: NearToken::from_yoctonear(amount.0),
            asset: Asset::Ft(token_id.clone()),
            memo: String::new(),
            request_hash: None,
            ts_ns: U64(env::block_timestamp()),
            policy_version: 0,
            delivered: None,
            pending_id: None,
            approved_by: None,
            storage_deposit: None,
        });
        let vault = env::current_account_id();
        ext_ft::ext(token_id)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(to, amount, Some(format!("allowance:{vault}#{receipt_id}")))
            .then(
                Self::ext(vault)
                    .with_static_gas(GAS_FOR_PAY_CALLBACK)
                    .on_ft_withdrawn(receipt_id),
            )
    }

    /// Callback of `withdraw_ft`.
    #[private]
    pub fn on_ft_withdrawn(&mut self, receipt_id: u64) -> bool {
        let ok = promise_succeeded();
        let receipt = self
            .receipts
            .get(&receipt_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("receipt missing in callback"));
        let Asset::Ft(token_id) = &receipt.asset else {
            env::panic_str("not a token receipt")
        };
        if ok {
            self.update_receipt(receipt_id, |r| r.status = ReceiptStatus::Paid);
            Event::Withdrawn {
                to: receipt.payee.clone(),
                amount: receipt.amount,
                asset: receipt.asset.clone(),
                receipt_id,
            }
            .emit();
        } else {
            self.ft_credit(token_id, receipt.amount.as_yoctonear());
            self.update_receipt(receipt_id, |r| {
                r.status = ReceiptStatus::Failed {
                    reason: Failure::FtTransferFailed,
                }
            });
        }
        ok
    }

    // ------------------------------------------------------------------
    // Agents
    // ------------------------------------------------------------------

    /// Owner: register an agent.
    ///
    /// For `AgentId::Key(pk)` the vault adds `pk` to **its own account** as a
    /// function-call key limited to [`AGENT_METHODS`] with `gas_allowance`
    /// (default: the vault's `key_gas_allowance`). Registration is completed
    /// in the `on_agent_key_added` callback, so a failed `AddKey` (for
    /// example a key that already exists on the account) leaves no agent
    /// behind. For `AgentId::Account(_)` the agent is registered immediately.
    ///
    /// Returns `true` once the agent is registered.
    pub fn add_agent(
        &mut self,
        agent_id: AgentId,
        label: String,
        policy: Policy,
        gas_allowance: Option<NearToken>,
    ) -> PromiseOrValue<bool> {
        self.assert_owner();
        require!(
            !self.agents.contains_key(&agent_id),
            "agent already registered"
        );
        require!(label.len() <= MAX_LABEL_BYTES, "label too long");
        self.assert_valid_policy(&policy);
        match &agent_id {
            AgentId::Key(pk) => {
                let allowance = gas_allowance.unwrap_or(self.key_gas_allowance);
                let allowance = Allowance::limited(allowance)
                    .unwrap_or_else(|| env::panic_str("gas_allowance must be > 0"));
                let vault = env::current_account_id();
                PromiseOrValue::Promise(
                    Promise::new(vault.clone())
                        .add_access_key_allowance(
                            pk.clone(),
                            allowance,
                            vault.clone(),
                            AGENT_METHODS,
                        )
                        .then(
                            Self::ext(vault)
                                .with_static_gas(GAS_FOR_KEY_CALLBACK)
                                .on_agent_key_added(agent_id.clone(), label, policy),
                        ),
                )
            }
            AgentId::Account(_) => {
                self.register_agent(agent_id, label, policy);
                PromiseOrValue::Value(true)
            }
        }
    }

    /// Callback of `add_agent` for key agents: registers the agent only if
    /// the protocol accepted the `AddKey` action.
    #[private]
    pub fn on_agent_key_added(
        &mut self,
        agent_id: AgentId,
        label: String,
        policy: Policy,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_err() {
            env::log_str(
                "add_agent: AddKey was refused by the protocol (key already on the account?); agent not registered",
            );
            return false;
        }
        if self.agents.contains_key(&agent_id) {
            env::log_str("add_agent: agent already registered; nothing to do");
            return true;
        }
        self.register_agent(agent_id, label, policy);
        true
    }

    /// Owner: replace an agent's policy. Spending counters are kept; bump the
    /// version so receipts can tell which rules they were evaluated under.
    /// Returns the new policy version.
    pub fn set_policy(&mut self, agent_id: AgentId, policy: Policy) -> u32 {
        self.assert_owner();
        self.assert_valid_policy(&policy);
        let agent = self.agent_mut(&agent_id);
        agent.policy = policy;
        agent.policy_version = agent.policy_version.saturating_add(1);
        let policy_version = agent.policy_version;
        Event::PolicySet {
            agent: agent_id,
            policy_version,
        }
        .emit();
        policy_version
    }

    /// Owner: stop an agent without touching its key (cheap, reversible).
    pub fn disable_agent(&mut self, agent_id: AgentId) {
        self.assert_owner();
        self.agent_mut(&agent_id).active = false;
        Event::AgentDisabled { agent: agent_id }.emit();
    }

    /// Owner: re-enable a disabled agent.
    pub fn enable_agent(&mut self, agent_id: AgentId) {
        self.assert_owner();
        self.agent_mut(&agent_id).active = true;
        Event::AgentEnabled { agent: agent_id }.emit();
    }

    /// Owner: forget an agent. For key agents the key is deleted from the
    /// vault account in the same transaction; queued approvals of the agent
    /// are denied.
    pub fn remove_agent(&mut self, agent_id: AgentId) -> PromiseOrValue<()> {
        self.assert_owner();
        require!(self.agents.remove(&agent_id).is_some(), "unknown agent");
        self.deny_pending_of(&agent_id);
        Event::AgentRemoved {
            agent: agent_id.clone(),
        }
        .emit();
        match agent_id {
            AgentId::Key(pk) => {
                PromiseOrValue::Promise(Promise::new(env::current_account_id()).delete_key(pk))
            }
            AgentId::Account(_) => PromiseOrValue::Value(()),
        }
    }

    /// Owner: give a key agent a fresh gas allowance. Allowances are
    /// immutable on NEAR, so the key is deleted and re-added in one atomic
    /// batch with the same method restrictions.
    pub fn top_up_allowance(
        &mut self,
        public_key: PublicKey,
        allowance: Option<NearToken>,
    ) -> Promise {
        self.assert_owner();
        let agent_id = AgentId::Key(public_key.clone());
        require!(self.agents.contains_key(&agent_id), "unknown agent");
        let amount = allowance.unwrap_or(self.key_gas_allowance);
        let allowance =
            Allowance::limited(amount).unwrap_or_else(|| env::panic_str("allowance must be > 0"));
        Event::KeyAllowanceToppedUp {
            agent: agent_id,
            allowance: amount,
        }
        .emit();
        let vault = env::current_account_id();
        Promise::new(vault.clone())
            .delete_key(public_key.clone())
            .add_access_key_allowance(public_key, allowance, vault, AGENT_METHODS)
    }

    /// Owner: replace the vault-wide denylist. A denylisted payee is refused
    /// for every agent, allowlisted or not.
    pub fn set_denylist(&mut self, accounts: Vec<AccountId>) {
        self.assert_owner();
        self.denylist.clear();
        for account in &accounts {
            self.denylist.insert(account.clone());
        }
        Event::DenylistSet { accounts }.emit();
    }

    /// Owner: set or clear the second approver.
    pub fn set_approver(&mut self, approver_id: Option<AccountId>) {
        self.assert_owner();
        self.approver_id = approver_id;
    }

    /// Owner: change how long approval requests stay open.
    pub fn set_approval_ttl(&mut self, ttl_ns: U64) {
        self.assert_owner();
        require!(ttl_ns.0 > 0, "approval_ttl_ns must be > 0");
        self.approval_ttl_ns = ttl_ns.0;
    }

    /// Owner: stop every payment (keys stay; `unpause` resumes).
    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        Event::VaultPaused {
            by: env::predecessor_account_id(),
        }
        .emit();
    }

    /// Owner: resume payments.
    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        Event::VaultUnpaused {
            by: env::predecessor_account_id(),
        }
        .emit();
    }

    /// Owner: kill switch. Pauses the vault, forgets every agent, denies every
    /// queued approval and deletes every agent key from the vault account, so
    /// a compromised agent is stopped at the protocol level (its next
    /// transaction is rejected before the contract runs). Receipts are kept.
    /// Returns the ids of the removed agents.
    pub fn kill(&mut self) -> Vec<AgentId> {
        self.assert_owner();
        self.paused = true;
        let ids: Vec<AgentId> = self.agents.keys().cloned().collect();
        let vault = env::current_account_id();
        for id in &ids {
            self.agents.remove(id);
            if let AgentId::Key(pk) = id {
                // One receipt per key so that one odd key cannot block the others.
                Promise::new(vault.clone()).delete_key(pk.clone()).detach();
            }
        }
        let pending_ids: Vec<u64> = self.pending.keys().copied().collect();
        for pending_id in pending_ids {
            self.settle_pending(pending_id, ReceiptStatus::Denied);
        }
        Event::VaultKilled {
            by: env::predecessor_account_id(),
            agents: ids.clone(),
        }
        .emit();
        ids
    }

    /// Owner: delete stored receipts with `id < before_id` (oldest first, at
    /// most `limit` per call, default 50) to reclaim storage. Receipts that
    /// are still pending are never pruned. Events stay in the chain's logs.
    /// Returns how many receipts were removed.
    pub fn prune_receipts(&mut self, before_id: u64, limit: Option<u64>) -> u64 {
        self.assert_owner();
        let end = before_id.min(self.next_receipt_id);
        let limit = limit.unwrap_or(DEFAULT_PAGE);
        let mut removed = 0;
        while self.first_receipt_id < end && removed < limit {
            let id = self.first_receipt_id;
            if let Some(receipt) = self.receipts.get(&id) {
                if receipt.status == ReceiptStatus::Pending {
                    break;
                }
                self.receipts.remove(&id);
                removed += 1;
            }
            self.first_receipt_id += 1;
        }
        removed
    }

    // ------------------------------------------------------------------
    // Approval queue
    // ------------------------------------------------------------------

    /// Owner or approver: release a queued payment. The policy is evaluated
    /// again at this moment (pause, expiry, budget, balance...), only the
    /// approval threshold is waived. An expired request is marked `expired`
    /// instead.
    pub fn approve(&mut self, pending_id: u64) -> PromiseOrValue<PayOutcome> {
        self.assert_approver();
        let pending = self.pending_or_panic(pending_id);
        let now = env::block_timestamp();
        if now >= pending.expires_at_ns.0 {
            self.settle_pending(pending_id, ReceiptStatus::Expired);
            return PromiseOrValue::Value(PayOutcome::Expired {
                receipt_id: pending.receipt_id,
                pending_id,
            });
        }
        let agent = self
            .agents
            .get(&pending.agent)
            .unwrap_or_else(|| env::panic_str("agent of this request no longer exists"));
        let ctx = EvalContext {
            now_ns: now,
            paused: self.paused,
            agent_active: agent.active,
            payee_denylisted: self.denylist.contains(&pending.payee),
            vault_available: self.available_for(&pending.asset),
            approval_granted: true,
        };
        let decision = evaluate(
            &agent.policy,
            &agent.state,
            &PayRequest {
                payee: &pending.payee,
                amount: pending.amount,
                asset: &pending.asset,
            },
            &ctx,
        );
        self.pending.remove(&pending_id);
        match decision {
            Err(reason) => {
                self.update_receipt(pending.receipt_id, |r| {
                    r.status = ReceiptStatus::Rejected {
                        reason: reason.clone(),
                    }
                });
                Event::PaymentRejected {
                    receipt_id: pending.receipt_id,
                    agent: pending.agent,
                    payee: pending.payee,
                    amount: pending.amount,
                    asset: pending.asset,
                    reason: reason.clone(),
                }
                .emit();
                PromiseOrValue::Value(PayOutcome::Rejected {
                    receipt_id: pending.receipt_id,
                    reason,
                })
            }
            Ok(_) => {
                let approver = env::predecessor_account_id();
                self.update_receipt(pending.receipt_id, |r| {
                    r.status = ReceiptStatus::Approved;
                    r.approved_by = Some(approver.clone());
                });
                Event::ApprovalGranted {
                    pending_id,
                    receipt_id: pending.receipt_id,
                    approver,
                }
                .emit();
                self.transfer(
                    pending.agent,
                    pending.receipt_id,
                    pending.payee,
                    pending.amount,
                    pending.asset,
                )
            }
        }
    }

    /// Owner or approver: refuse a queued payment (an expired one is marked
    /// `expired`).
    pub fn deny(&mut self, pending_id: u64) {
        self.assert_approver();
        let pending = self.pending_or_panic(pending_id);
        let status = if env::block_timestamp() >= pending.expires_at_ns.0 {
            ReceiptStatus::Expired
        } else {
            ReceiptStatus::Denied
        };
        self.settle_pending(pending_id, status);
    }

    /// Anyone: garbage-collect an approval request whose TTL has passed.
    pub fn expire_pending(&mut self, pending_id: u64) -> bool {
        let pending = self.pending_or_panic(pending_id);
        require!(
            env::block_timestamp() >= pending.expires_at_ns.0,
            "approval request has not expired yet"
        );
        self.settle_pending(pending_id, ReceiptStatus::Expired);
        true
    }

    // ------------------------------------------------------------------
    // Agent methods (callable with the function-call key)
    // ------------------------------------------------------------------

    /// Agent: pay `amount` of `asset` (default NEAR; the policy's asset) to
    /// `payee` under the caller's policy.
    ///
    /// Never panics for policy reasons: a refused payment is recorded as a
    /// `rejected` receipt and returned as `{"outcome":"rejected",...}`. A
    /// payment above the approval threshold is queued and returned as
    /// `needs_approval`. Otherwise the budget is reserved, a `pending` receipt
    /// is written and the transfer is issued; the callback settles the receipt
    /// as `paid` or `failed` (releasing the budget) and the transaction's
    /// final value is that outcome.
    ///
    /// `request_hash` (32 bytes, base64) lets a payee bind the receipt to a
    /// specific request, see `verify_receipt`.
    ///
    /// NEP-141 payments: the vault checks the payee's storage on the token
    /// (`storage_balance_of`), registers it if the policy's
    /// `ft_storage_deposit` allows, then calls `ft_transfer` with the memo
    /// `allowance:<vault>#<receipt id>`. Budget and token balance are
    /// reserved before the first cross-contract call and released if any step
    /// fails, exactly like a failed NEAR transfer.
    pub fn pay(
        &mut self,
        payee: AccountId,
        amount: NearToken,
        asset: Option<Asset>,
        memo: Option<String>,
        request_hash: Option<Base64VecU8>,
    ) -> PromiseOrValue<PayOutcome> {
        let agent_id = self.caller_agent_id();
        let (policy, state, active, policy_version) = {
            let agent = self
                .agents
                .get(&agent_id)
                .unwrap_or_else(|| env::panic_str("unknown agent"));
            (
                agent.policy.clone(),
                agent.state.clone(),
                agent.active,
                agent.policy_version,
            )
        };
        let memo = memo.unwrap_or_default();
        require!(
            memo.len() <= MAX_MEMO_BYTES,
            "memo too long (max 256 bytes)"
        );
        if let Some(hash) = &request_hash {
            require!(
                hash.0.len() == REQUEST_HASH_BYTES,
                "request_hash must be exactly 32 bytes"
            );
        }
        require!(
            payee != env::current_account_id(),
            "payee cannot be the vault itself"
        );
        require!(!amount.is_zero(), "amount must be > 0");
        let asset = asset.unwrap_or_default();
        let now = env::block_timestamp();
        let ctx = EvalContext {
            now_ns: now,
            paused: self.paused,
            agent_active: active,
            payee_denylisted: self.denylist.contains(&payee),
            vault_available: self.available_for(&asset),
            approval_granted: false,
        };
        let decision = evaluate(
            &policy,
            &state,
            &PayRequest {
                payee: &payee,
                amount,
                asset: &asset,
            },
            &ctx,
        );
        let mut receipt = Receipt {
            id: 0,
            kind: ReceiptKind::Pay,
            status: ReceiptStatus::Pending,
            agent: agent_id.clone(),
            payee: payee.clone(),
            amount,
            asset: asset.clone(),
            memo: memo.clone(),
            request_hash: request_hash.clone(),
            ts_ns: U64(now),
            policy_version,
            delivered: None,
            pending_id: None,
            approved_by: None,
            storage_deposit: None,
        };
        match decision {
            Err(reason) => {
                receipt.status = ReceiptStatus::Rejected {
                    reason: reason.clone(),
                };
                let receipt_id = self.push_receipt(receipt);
                Event::PaymentRejected {
                    receipt_id,
                    agent: agent_id,
                    payee,
                    amount,
                    asset,
                    reason: reason.clone(),
                }
                .emit();
                PromiseOrValue::Value(PayOutcome::Rejected { receipt_id, reason })
            }
            Ok(Decision::NeedsApproval { .. }) => {
                let pending_id = self.next_pending_id;
                self.next_pending_id += 1;
                receipt.pending_id = Some(pending_id);
                let receipt_id = self.push_receipt(receipt);
                let expires_at_ns = U64(now.saturating_add(self.approval_ttl_ns));
                self.pending.insert(
                    pending_id,
                    Pending {
                        id: pending_id,
                        receipt_id,
                        agent: agent_id.clone(),
                        payee: payee.clone(),
                        amount,
                        asset: asset.clone(),
                        memo,
                        request_hash,
                        created_at_ns: U64(now),
                        expires_at_ns,
                    },
                );
                Event::ApprovalRequested {
                    pending_id,
                    receipt_id,
                    agent: agent_id,
                    payee,
                    amount,
                    asset,
                    expires_at_ns,
                }
                .emit();
                PromiseOrValue::Value(PayOutcome::NeedsApproval {
                    receipt_id,
                    pending_id,
                    expires_at_ns,
                })
            }
            Ok(Decision::Pay) => {
                let receipt_id = self.push_receipt(receipt);
                self.transfer(agent_id, receipt_id, payee, amount, asset)
            }
        }
    }

    /// Callback of the transfer issued by `pay`/`approve` (a NEAR transfer
    /// or the token's `ft_transfer`): settles the receipt and, on failure,
    /// releases the budget reservation and the reserved tokens. Reads the
    /// promise result itself, so whatever a token returns cannot make the
    /// settlement panic and leave the receipt pending.
    #[private]
    pub fn on_paid(
        &mut self,
        receipt_id: u64,
        agent_id: AgentId,
        amount: NearToken,
        window_start_ns: U64,
    ) -> PayOutcome {
        let ok = promise_succeeded();
        self.settle_payment(receipt_id, agent_id, amount, window_start_ns, ok)
    }

    /// Callback of the token's `storage_balance_of(payee)` in a NEP-141
    /// payment: transfer if the payee is registered; otherwise register it
    /// first if the policy allows (`ft_storage_deposit`), or fail.
    #[private]
    pub fn on_ft_storage_checked(
        &mut self,
        receipt_id: u64,
        agent_id: AgentId,
        amount: NearToken,
        window_start_ns: U64,
        ft_storage_deposit: Option<NearToken>,
    ) -> PromiseOrValue<PayOutcome> {
        let registered = env::promise_result_checked(0, MAX_TOKEN_RESULT_BYTES)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Option<serde_json::Value>>(&bytes).ok())
            .map(|balance| balance.is_some());
        self.ft_transfer_after_storage_check(
            receipt_id,
            agent_id,
            amount,
            window_start_ns,
            ft_storage_deposit,
            registered,
        )
    }

    /// Agent: record whether what it paid for was delivered. Only the agent
    /// that paid may confirm, only once, only on a paid receipt.
    pub fn confirm_delivery(&mut self, receipt_id: u64, passed: bool) {
        let agent_id = self.caller_agent_id();
        let receipt = self
            .receipts
            .get_mut(&receipt_id)
            .unwrap_or_else(|| env::panic_str("unknown receipt"));
        require!(
            receipt.agent == agent_id,
            "only the paying agent may confirm"
        );
        require!(
            receipt.kind == ReceiptKind::Pay && receipt.status == ReceiptStatus::Paid,
            "receipt is not a paid payment"
        );
        require!(receipt.delivered.is_none(), "delivery already confirmed");
        receipt.delivered = Some(passed);
        Event::DeliveryConfirmed {
            receipt_id,
            agent: agent_id,
            passed,
        }
        .emit();
    }

    /// Agent: cheap liveness check that also tells the agent how the vault
    /// identifies it. Call it as a transaction with the agent key.
    pub fn ping(&self) -> PingResponse {
        let agent_id = self.caller_agent_id();
        let agent = self.agents.get(&agent_id);
        PingResponse {
            registered: agent.is_some(),
            label: agent.map(|a| a.label.clone()),
            active: agent.map(|a| a.active).unwrap_or(false),
            paused: self.paused,
            block_timestamp_ns: U64(env::block_timestamp()),
            agent: agent_id,
        }
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// Free dry-run: what would `pay` do right now? `agent_id` defaults to
    /// the caller (useful when called as a transaction by the agent key).
    pub fn simulate(
        &self,
        agent_id: Option<AgentId>,
        payee: AccountId,
        amount: NearToken,
        asset: Option<Asset>,
    ) -> Simulation {
        let agent_id = agent_id.unwrap_or_else(|| self.caller_agent_id());
        let now = env::block_timestamp();
        let asset = asset.unwrap_or_default();
        // In the asset's unit: NEAR above the storage reserve, or the vault's token balance.
        let vault_available = self.available_for(&asset);
        let Some(agent) = self.agents.get(&agent_id) else {
            return Simulation {
                verdict: Verdict::Block,
                reason: Some(Rejection::UnknownAgent),
                agent: agent_id,
                policy_version: 0,
                remaining_budget: None,
                budget_resets_at_ns: None,
                vault_available,
                block_timestamp_ns: U64(now),
            };
        };
        let ctx = EvalContext {
            now_ns: now,
            paused: self.paused,
            agent_active: agent.active,
            payee_denylisted: self.denylist.contains(&payee),
            vault_available,
            approval_granted: false,
        };
        let decision = evaluate(
            &agent.policy,
            &agent.state,
            &PayRequest {
                payee: &payee,
                amount,
                asset: &asset,
            },
            &ctx,
        );
        let (verdict, reason) = match decision {
            Ok(Decision::Pay) => (Verdict::Allow, None),
            Ok(Decision::NeedsApproval { .. }) => (Verdict::NeedsApproval, None),
            Err(reason) => (Verdict::Block, Some(reason)),
        };
        let budget = agent.policy.budget.as_ref();
        Simulation {
            verdict,
            reason,
            agent: agent_id,
            policy_version: agent.policy_version,
            remaining_budget: budget.map(|b| agent.state.remaining_at(b, now)),
            budget_resets_at_ns: budget.map(|b| U64(b.resets_at(now))),
            vault_available,
            block_timestamp_ns: U64(now),
        }
    }

    /// Payee-side check: is receipt `receipt_id` a paid agent payment to
    /// `payee` of at least `min_amount` of `asset`, bound to `request_hash` if
    /// given? `asset` defaults to NEAR, so a payee that prices in NEAR can
    /// never be fooled by a token receipt with a bigger number.
    pub fn verify_receipt(
        &self,
        receipt_id: u64,
        payee: AccountId,
        min_amount: NearToken,
        request_hash: Option<Base64VecU8>,
        asset: Option<Asset>,
    ) -> bool {
        let Some(receipt) = self.receipts.get(&receipt_id) else {
            return false;
        };
        receipt.kind == ReceiptKind::Pay
            && receipt.status == ReceiptStatus::Paid
            && receipt.payee == payee
            && receipt.asset == asset.unwrap_or_default()
            && receipt.amount >= min_amount
            && match request_hash {
                None => true,
                Some(hash) => receipt.request_hash.as_ref().map(|h| h.0 == hash.0) == Some(true),
            }
    }

    pub fn get_vault(&self) -> VaultInfo {
        VaultInfo {
            owner_id: self.owner_id.clone(),
            approver_id: self.approver_id.clone(),
            paused: self.paused,
            balance: env::account_balance(),
            available: self.available_balance(),
            storage_usage_bytes: env::storage_usage(),
            agents: self.agents.len(),
            next_receipt_id: self.next_receipt_id,
            first_receipt_id: self.first_receipt_id,
            pending: self.pending.len(),
            approval_ttl_ns: U64(self.approval_ttl_ns),
            key_gas_allowance: self.key_gas_allowance,
            tokens: self
                .tokens
                .iter()
                .map(|(id, t)| token_view(id, t))
                .collect(),
            block_timestamp_ns: U64(env::block_timestamp()),
            version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }

    pub fn get_agent(&self, agent_id: AgentId) -> Option<AgentView> {
        let now = env::block_timestamp();
        self.agents
            .get(&agent_id)
            .map(|agent| AgentView::new(agent_id, agent, now))
    }

    pub fn get_agents(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<AgentView> {
        let now = env::block_timestamp();
        self.agents
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(DEFAULT_PAGE as u32) as usize)
            .map(|(id, agent)| AgentView::new(id.clone(), agent, now))
            .collect()
    }

    pub fn get_policy(&self, agent_id: AgentId) -> Option<Policy> {
        self.agents.get(&agent_id).map(|a| a.policy.clone())
    }

    pub fn get_agent_state(&self, agent_id: AgentId) -> Option<policy::SpendState> {
        self.agents.get(&agent_id).map(|a| a.state.clone())
    }

    pub fn get_receipt(&self, receipt_id: u64) -> Option<Receipt> {
        self.receipts.get(&receipt_id).cloned()
    }

    /// Receipts with ids in `[from_id, from_id + limit)` that still exist.
    pub fn get_receipts(&self, from_id: Option<u64>, limit: Option<u64>) -> Vec<Receipt> {
        let from = from_id.unwrap_or(self.first_receipt_id);
        let to = from
            .saturating_add(limit.unwrap_or(DEFAULT_PAGE))
            .min(self.next_receipt_id);
        (from..to)
            .filter_map(|id| self.receipts.get(&id).cloned())
            .collect()
    }

    /// Open approval requests (compare `expires_at_ns` with
    /// `get_vault().block_timestamp_ns` to spot expired ones).
    pub fn get_pending(&self) -> Vec<Pending> {
        self.pending.values().cloned().collect()
    }

    pub fn get_pending_by_id(&self, pending_id: u64) -> Option<Pending> {
        self.pending.get(&pending_id).cloned()
    }

    pub fn get_denylist(&self) -> Vec<AccountId> {
        self.denylist.iter().cloned().collect()
    }

    /// A registered NEP-141 token and the balance the vault accounts for.
    pub fn get_token(&self, token_id: AccountId) -> Option<TokenView> {
        self.tokens.get(&token_id).map(|t| token_view(&token_id, t))
    }
}

// ----------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------

impl Vault {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "only the owner can call this method"
        );
    }

    fn assert_approver(&self) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner_id || Some(&caller) == self.approver_id.as_ref(),
            "only the owner or the approver can call this method"
        );
    }

    /// Who is calling `pay`/`confirm_delivery`/`ping`/`simulate`?
    /// A key on the vault account calls the vault with
    /// `predecessor == signer == current account`, so the key is the identity;
    /// any other predecessor is an account-based agent.
    fn caller_agent_id(&self) -> AgentId {
        let predecessor = env::predecessor_account_id();
        if predecessor == env::current_account_id() {
            AgentId::Key(env::signer_account_pk())
        } else {
            AgentId::Account(predecessor)
        }
    }

    fn assert_valid_policy(&self, policy: &Policy) {
        if let Err(msg) = policy.validate() {
            env::panic_str(&format!("invalid policy: {msg}"));
        }
        if let Asset::Ft(token_id) = &policy.asset {
            require!(
                self.tokens.contains_key(token_id),
                "invalid policy: register the token first (register_token)"
            );
        }
    }

    fn agent_mut(&mut self, agent_id: &AgentId) -> &mut Agent {
        self.agents
            .get_mut(agent_id)
            .unwrap_or_else(|| env::panic_str("unknown agent"))
    }

    fn register_agent(&mut self, agent_id: AgentId, label: String, policy: Policy) {
        self.agents.insert(
            agent_id.clone(),
            Agent {
                label: label.clone(),
                policy,
                state: Default::default(),
                active: true,
                policy_version: 1,
                added_at_ns: U64(env::block_timestamp()),
            },
        );
        Event::AgentAdded {
            agent: agent_id.clone(),
            label,
            policy_version: 1,
        }
        .emit();
        Event::PolicySet {
            agent: agent_id,
            policy_version: 1,
        }
        .emit();
    }

    /// Balance the vault may pay out: total minus the storage stake minus a
    /// small headroom for the next receipt.
    fn available_balance(&self) -> NearToken {
        let reserve = env::storage_byte_cost()
            .saturating_mul(u128::from(env::storage_usage()))
            .saturating_add(STORAGE_HEADROOM);
        env::account_balance().saturating_sub(reserve)
    }

    /// What the vault can pay in `asset` right now: NEAR above the storage
    /// reserve, or its accounted token balance.
    fn available_for(&self, asset: &Asset) -> NearToken {
        match asset {
            Asset::Near => self.available_balance(),
            Asset::Ft(token_id) => {
                NearToken::from_yoctonear(self.tokens.get(token_id).map(|t| t.balance).unwrap_or(0))
            }
        }
    }

    fn ft_credit(&mut self, token_id: &AccountId, amount: u128) {
        match self.tokens.get_mut(token_id) {
            Some(token) => token.balance = token.balance.saturating_add(amount),
            None => {
                self.tokens.insert(
                    token_id.clone(),
                    TokenAccount {
                        balance: amount,
                        min_deposit: 1,
                    },
                );
            }
        }
    }

    fn ft_debit(&mut self, token_id: &AccountId, amount: u128) {
        let token = self
            .tokens
            .get_mut(token_id)
            .unwrap_or_else(|| env::panic_str("token not registered"));
        token.balance = token
            .balance
            .checked_sub(amount)
            .unwrap_or_else(|| env::panic_str("token balance too low"));
    }

    fn push_receipt(&mut self, mut receipt: Receipt) -> u64 {
        let id = self.next_receipt_id;
        receipt.id = id;
        self.receipts.insert(id, receipt);
        self.next_receipt_id += 1;
        id
    }

    fn update_receipt(&mut self, receipt_id: u64, f: impl FnOnce(&mut Receipt)) {
        let receipt = self
            .receipts
            .get_mut(&receipt_id)
            .unwrap_or_else(|| env::panic_str("unknown receipt"));
        f(receipt);
    }

    fn pending_or_panic(&self, pending_id: u64) -> Pending {
        self.pending
            .get(&pending_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown pending id"))
    }

    /// Close an approval request without paying (`denied` or `expired`).
    fn settle_pending(&mut self, pending_id: u64, status: ReceiptStatus) {
        let Some(pending) = self.pending.remove(&pending_id) else {
            return;
        };
        let receipt_id = pending.receipt_id;
        self.update_receipt(receipt_id, |r| r.status = status.clone());
        match status {
            ReceiptStatus::Expired => Event::ApprovalExpired {
                pending_id,
                receipt_id,
            }
            .emit(),
            _ => Event::ApprovalDenied {
                pending_id,
                receipt_id,
                approver: env::predecessor_account_id(),
            }
            .emit(),
        }
    }

    fn deny_pending_of(&mut self, agent_id: &AgentId) {
        let ids: Vec<u64> = self
            .pending
            .iter()
            .filter(|(_, p)| &p.agent == agent_id)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.settle_pending(id, ReceiptStatus::Denied);
        }
    }

    /// Reserve the budget (and, for tokens, the vault's token balance) and
    /// issue the transfer with its settlement callback.
    fn transfer(
        &mut self,
        agent_id: AgentId,
        receipt_id: u64,
        payee: AccountId,
        amount: NearToken,
        asset: Asset,
    ) -> PromiseOrValue<PayOutcome> {
        let now = env::block_timestamp();
        let (window_start_ns, ft_storage_deposit) = {
            let agent = self.agent_mut(&agent_id);
            agent
                .state
                .record_payment(agent.policy.budget.as_ref(), amount, now);
            (agent.state.window_start_ns, agent.policy.ft_storage_deposit)
        };
        let vault = env::current_account_id();
        let promise = match asset {
            Asset::Near => Promise::new(payee).transfer(amount).then(
                Self::ext(vault)
                    .with_static_gas(GAS_FOR_PAY_CALLBACK)
                    .on_paid(receipt_id, agent_id, amount, window_start_ns),
            ),
            Asset::Ft(token_id) => {
                self.ft_debit(&token_id, amount.as_yoctonear());
                ext_ft::ext(token_id)
                    .with_static_gas(GAS_FOR_FT_STORAGE_CHECK)
                    .storage_balance_of(payee)
                    .then(
                        Self::ext(vault)
                            .with_static_gas(GAS_FOR_FT_STEP)
                            .on_ft_storage_checked(
                                receipt_id,
                                agent_id,
                                amount,
                                window_start_ns,
                                ft_storage_deposit,
                            ),
                    )
            }
        };
        PromiseOrValue::Promise(promise)
    }

    /// Second step of a NEP-141 payment. `registered` is the payee's NEP-145
    /// registration on the token (`None`: the check failed or answered
    /// something that is not NEP-145).
    fn ft_transfer_after_storage_check(
        &mut self,
        receipt_id: u64,
        agent_id: AgentId,
        amount: NearToken,
        window_start_ns: U64,
        ft_storage_deposit: Option<NearToken>,
        registered: Option<bool>,
    ) -> PromiseOrValue<PayOutcome> {
        let receipt = self
            .receipts
            .get(&receipt_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("receipt missing in callback"));
        let Asset::Ft(token_id) = receipt.asset else {
            env::panic_str("not a token payment")
        };
        let fail = |this: &mut Self, reason| {
            PromiseOrValue::Value(this.fail_payment(
                receipt_id,
                agent_id.clone(),
                amount,
                window_start_ns,
                reason,
            ))
        };
        let Some(registered) = registered else {
            return fail(self, Failure::StorageCheckFailed);
        };
        let vault = env::current_account_id();
        let transfer = ext_ft::ext(token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(
                receipt.payee.clone(),
                U128(amount.as_yoctonear()),
                Some(format!("allowance:{vault}#{receipt_id}")),
            );
        let settle = Self::ext(vault)
            .with_static_gas(GAS_FOR_PAY_CALLBACK)
            .on_paid(receipt_id, agent_id.clone(), amount, window_start_ns);
        if registered {
            return PromiseOrValue::Promise(transfer.then(settle));
        }
        let Some(deposit) = ft_storage_deposit else {
            return fail(self, Failure::PayeeNotRegistered);
        };
        if deposit > self.available_balance() {
            return fail(self, Failure::InsufficientNearForStorage);
        }
        self.update_receipt(receipt_id, |r| r.storage_deposit = Some(deposit));
        Event::FtPayeeRegistration {
            receipt_id,
            token_id: token_id.clone(),
            payee: receipt.payee.clone(),
            attached: deposit,
        }
        .emit();
        // `then` runs the transfer whatever the registration did; if it
        // failed, the transfer fails too and `on_paid` releases everything
        // (the attached NEAR comes back to the vault with the failed call).
        PromiseOrValue::Promise(
            ext_ft::ext(token_id)
                .with_attached_deposit(deposit)
                .with_static_gas(GAS_FOR_FT_STORAGE_DEPOSIT)
                .storage_deposit(Some(receipt.payee), Some(true))
                .then(transfer)
                .then(settle),
        )
    }

    /// Settle a payment once the transfer (NEAR or `ft_transfer`) finished.
    fn settle_payment(
        &mut self,
        receipt_id: u64,
        agent_id: AgentId,
        amount: NearToken,
        window_start_ns: U64,
        transferred: bool,
    ) -> PayOutcome {
        let receipt = self
            .receipts
            .get(&receipt_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("receipt missing in callback"));
        if !transferred {
            let reason = match receipt.asset {
                Asset::Near => Failure::TransferFailed,
                Asset::Ft(_) => Failure::FtTransferFailed,
            };
            return self.fail_payment(receipt_id, agent_id, amount, window_start_ns, reason);
        }
        self.update_receipt(receipt_id, |r| r.status = ReceiptStatus::Paid);
        Event::PaymentPaid {
            receipt_id,
            agent: agent_id,
            payee: receipt.payee,
            amount,
            asset: receipt.asset,
        }
        .emit();
        PayOutcome::Paid { receipt_id }
    }

    /// Mark a payment `failed` and give back what it reserved: the budget
    /// (in the window it was reserved in) and, for tokens, the vault's
    /// token balance.
    fn fail_payment(
        &mut self,
        receipt_id: u64,
        agent_id: AgentId,
        amount: NearToken,
        window_start_ns: U64,
        reason: Failure,
    ) -> PayOutcome {
        let receipt = self
            .receipts
            .get(&receipt_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("receipt missing in callback"));
        self.update_receipt(receipt_id, |r| r.status = ReceiptStatus::Failed { reason });
        if let Some(agent) = self.agents.get_mut(&agent_id) {
            agent.state.release(amount, window_start_ns.0);
        }
        if let Asset::Ft(token_id) = &receipt.asset {
            self.ft_credit(token_id, amount.as_yoctonear());
        }
        Event::PaymentFailed {
            receipt_id,
            agent: agent_id,
            payee: receipt.payee,
            amount,
            asset: receipt.asset,
            reason,
        }
        .emit();
        PayOutcome::Failed { receipt_id, reason }
    }
}

/// True unless the promise this callback waits for failed. Reads only the
/// status (a long or odd return value from a token is not an error).
fn promise_succeeded() -> bool {
    !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed))
}

fn token_view(token_id: &AccountId, token: &TokenAccount) -> TokenView {
    TokenView {
        token_id: token_id.clone(),
        balance: U128(token.balance),
        min_deposit: U128(token.min_deposit),
    }
}

/// `text` cut to at most `max` bytes on a character boundary.
fn truncate_utf8(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, get_logs};
    use near_sdk::testing_env;
    use policy::{Allow, AllowEntry, Budget};

    const DAY_NS: u64 = 86_400 * NS_PER_SEC;
    const T0: u64 = 1_793_577_600 * NS_PER_SEC;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn vault_id() -> AccountId {
        acc("vault.test")
    }
    fn owner() -> AccountId {
        acc("owner.test")
    }
    fn api() -> AccountId {
        acc("api.test")
    }
    fn worker() -> AgentId {
        AgentId::Account(acc("worker.test"))
    }
    fn near(n: u128) -> NearToken {
        NearToken::from_near(n)
    }
    fn millinear(n: u128) -> NearToken {
        NearToken::from_millinear(n)
    }

    fn context(predecessor: AccountId, now_ns: u64) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(vault_id())
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .account_balance(near(10))
            // VMContextBuilder defaults to 1 MB of storage; use a realistic footprint.
            .storage_usage(10_000)
            .block_timestamp(now_ns);
        builder
    }

    fn set_caller(predecessor: AccountId, now_ns: u64) {
        testing_env!(context(predecessor, now_ns).build());
    }

    fn policy() -> Policy {
        Policy {
            asset: Asset::Near,
            per_tx_cap: near(1),
            budget: Some(Budget {
                amount: near(2),
                period_ns: U64(DAY_NS),
            }),
            allow: Allow::List(vec![AllowEntry {
                account_id: api(),
                methods: None,
            }]),
            time_window: None,
            cooldown_ns: U64(0),
            approval_threshold: Some(millinear(500)),
            expires_at_ns: None,
            ft_storage_deposit: None,
        }
    }

    /// Vault with one account-based agent "worker" and 1 NEAR deposited.
    fn vault_with_worker() -> Vault {
        set_caller(owner(), T0);
        let mut vault = Vault::new(owner(), Some(acc("approver.test")), Some(U64(DAY_NS)), None);
        testing_env!(context(owner(), T0).attached_deposit(near(1)).build());
        vault.deposit();
        set_caller(owner(), T0);
        let _ = vault.add_agent(worker(), "worker".into(), policy(), None);
        vault
    }

    fn events() -> Vec<String> {
        get_logs()
            .into_iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:").map(str::to_string))
            .collect()
    }

    #[test]
    fn deposit_records_an_income_receipt_and_event() {
        let vault = vault_with_worker();
        let receipt = vault.get_receipt(0).unwrap();
        assert_eq!(receipt.kind, ReceiptKind::Income);
        assert_eq!(receipt.status, ReceiptStatus::Paid);
        assert_eq!(receipt.amount, near(1));
        assert_eq!(receipt.agent, AgentId::Account(owner()));
        assert_eq!(vault.get_vault().next_receipt_id, 1);
        assert_eq!(vault.get_agents(None, None).len(), 1);
    }

    #[test]
    #[should_panic(expected = "deposit at least 0.01 NEAR")]
    fn dust_deposits_are_refused() {
        set_caller(owner(), T0);
        let mut vault = Vault::new(owner(), None, None, None);
        testing_env!(
            context(owner(), T0)
                .attached_deposit(NearToken::from_yoctonear(1))
                .build()
        );
        vault.deposit();
    }

    #[test]
    #[should_panic(expected = "only the owner can call this method")]
    fn only_the_owner_adds_agents() {
        set_caller(owner(), T0);
        let mut vault = Vault::new(owner(), None, None, None);
        set_caller(acc("mallory.test"), T0);
        let _ = vault.add_agent(worker(), "x".into(), policy(), None);
    }

    #[test]
    #[should_panic(expected = "invalid policy: approval_threshold must be below per_tx_cap")]
    fn inconsistent_policies_are_refused() {
        set_caller(owner(), T0);
        let mut vault = Vault::new(owner(), None, None, None);
        let mut bad = policy();
        bad.approval_threshold = Some(near(1));
        let _ = vault.add_agent(worker(), "x".into(), bad, None);
    }

    #[test]
    fn agent_pays_and_the_callback_settles_the_receipt() {
        let mut vault = vault_with_worker();
        set_caller(acc("worker.test"), T0);
        let sim = vault.simulate(None, api(), millinear(20), None);
        assert_eq!(sim.verdict, Verdict::Allow);
        assert_eq!(sim.remaining_budget, Some(near(2)));

        let hash = Base64VecU8(vec![7u8; 32]);
        let outcome = vault.pay(
            api(),
            millinear(20),
            None,
            Some("quote".into()),
            Some(hash.clone()),
        );
        assert!(matches!(outcome, PromiseOrValue::Promise(_)));
        let receipt = vault.get_receipt(1).unwrap();
        assert_eq!(receipt.status, ReceiptStatus::Pending);
        assert_eq!(receipt.policy_version, 1);
        // Budget is reserved before the transfer completes.
        let state = vault.get_agent_state(worker()).unwrap();
        assert_eq!(state.spent_in_window, millinear(20));
        assert_eq!(state.payments, 1);
        assert!(!vault.verify_receipt(1, api(), millinear(20), None, None));

        set_caller(vault_id(), T0 + 1);
        let settled = vault.settle_payment(1, worker(), millinear(20), state.window_start_ns, true);
        assert_eq!(settled, PayOutcome::Paid { receipt_id: 1 });
        assert!(vault.verify_receipt(1, api(), millinear(20), Some(hash), None));
        assert!(vault.verify_receipt(1, api(), millinear(10), None, None));
        assert!(
            !vault.verify_receipt(1, api(), millinear(21), None, None),
            "amount too small"
        );
        assert!(
            !vault.verify_receipt(1, acc("other.test"), millinear(20), None, None),
            "wrong payee"
        );
        assert!(
            !vault.verify_receipt(
                1,
                api(),
                millinear(20),
                Some(Base64VecU8(vec![8u8; 32])),
                None
            ),
            "wrong request hash"
        );
        assert!(
            events()
                .iter()
                .any(|e| e.contains("\"event\":\"payment_paid\""))
        );

        // Only the paying agent confirms delivery, once.
        set_caller(acc("worker.test"), T0 + 2);
        vault.confirm_delivery(1, true);
        assert_eq!(vault.get_receipt(1).unwrap().delivered, Some(true));
    }

    #[test]
    #[should_panic(expected = "delivery already confirmed")]
    fn delivery_is_confirmed_once() {
        let mut vault = vault_with_worker();
        set_caller(acc("worker.test"), T0);
        let _ = vault.pay(api(), millinear(20), None, None, None);
        set_caller(vault_id(), T0);
        vault.settle_payment(1, worker(), millinear(20), U64(T0), true);
        set_caller(acc("worker.test"), T0);
        vault.confirm_delivery(1, true);
        vault.confirm_delivery(1, false);
    }

    #[test]
    #[should_panic(expected = "only the paying agent may confirm")]
    fn strangers_cannot_confirm_delivery() {
        let mut vault = vault_with_worker();
        set_caller(acc("worker.test"), T0);
        let _ = vault.pay(api(), millinear(20), None, None, None);
        set_caller(vault_id(), T0);
        vault.settle_payment(1, worker(), millinear(20), U64(T0), true);
        set_caller(acc("mallory.test"), T0);
        vault.confirm_delivery(1, true);
    }

    #[test]
    fn failed_transfer_marks_the_receipt_and_releases_the_budget() {
        let mut vault = vault_with_worker();
        set_caller(acc("worker.test"), T0);
        let _ = vault.pay(api(), millinear(20), None, None, None);
        let window = vault.get_agent_state(worker()).unwrap().window_start_ns;
        set_caller(vault_id(), T0 + 1);
        let settled = vault.settle_payment(1, worker(), millinear(20), window, false);
        let reason = Failure::TransferFailed;
        assert_eq!(
            settled,
            PayOutcome::Failed {
                receipt_id: 1,
                reason
            }
        );
        assert_eq!(
            vault.get_receipt(1).unwrap().status,
            ReceiptStatus::Failed { reason }
        );
        assert_eq!(
            vault.get_agent_state(worker()).unwrap().spent_in_window,
            near(0)
        );
        assert!(!vault.verify_receipt(1, api(), millinear(20), None, None));
        assert!(
            events()
                .iter()
                .any(|e| e.contains("\"event\":\"payment_failed\""))
        );
    }

    #[test]
    fn rejections_are_recorded_without_a_transfer() {
        let mut vault = vault_with_worker();
        set_caller(acc("worker.test"), T0);
        let attacker = acc("attacker.test");
        let sim = vault.simulate(None, attacker.clone(), near(2), None);
        assert_eq!(sim.verdict, Verdict::Block);
        assert_eq!(
            sim.reason,
            Some(Rejection::NotAllowlisted {
                payee: attacker.clone()
            })
        );

        let outcome = vault.pay(attacker.clone(), near(2), None, None, None);
        match outcome {
            PromiseOrValue::Value(PayOutcome::Rejected { receipt_id, reason }) => {
                assert_eq!(receipt_id, 1);
                assert_eq!(reason, Rejection::NotAllowlisted { payee: attacker });
            }
            _ => panic!("expected a rejection value, not a promise"),
        }
        assert!(matches!(
            vault.get_receipt(1).unwrap().status,
            ReceiptStatus::Rejected { .. }
        ));
        assert_eq!(vault.get_agent_state(worker()).unwrap().payments, 0);
        assert!(
            events()
                .iter()
                .any(|e| e.contains("\"event\":\"payment_rejected\"")
                    && e.contains("\"code\":\"not_allowlisted\""))
        );
    }

    #[test]
    fn denylist_is_vault_wide() {
        let mut vault = vault_with_worker();
        set_caller(owner(), T0);
        vault.set_denylist(vec![api()]);
        assert_eq!(vault.get_denylist(), vec![api()]);
        set_caller(acc("worker.test"), T0);
        let sim = vault.simulate(None, api(), millinear(1), None);
        assert_eq!(sim.reason, Some(Rejection::Denylisted { payee: api() }));
        set_caller(owner(), T0);
        vault.set_denylist(vec![]);
        set_caller(acc("worker.test"), T0);
        assert_eq!(
            vault.simulate(None, api(), millinear(1), None).verdict,
            Verdict::Allow
        );
    }

    #[test]
    #[should_panic(expected = "unknown agent")]
    fn unregistered_callers_cannot_write_receipts() {
        let mut vault = vault_with_worker();
        set_caller(acc("stranger.test"), T0);
        let _ = vault.pay(api(), millinear(1), None, None, None);
    }

    #[test]
    fn simulate_reports_unknown_agents_instead_of_panicking() {
        let vault = vault_with_worker();
        set_caller(acc("stranger.test"), T0);
        let sim = vault.simulate(None, api(), millinear(1), None);
        assert_eq!(sim.verdict, Verdict::Block);
        assert_eq!(sim.reason, Some(Rejection::UnknownAgent));
    }

    #[test]
    fn large_payment_waits_for_approval_and_is_paid_when_approved() {
        let mut vault = vault_with_worker();
        set_caller(acc("worker.test"), T0);
        assert_eq!(
            vault.simulate(None, api(), millinear(800), None).verdict,
            Verdict::NeedsApproval
        );
        let outcome = vault.pay(api(), millinear(800), None, Some("big job".into()), None);
        let (receipt_id, pending_id) = match outcome {
            PromiseOrValue::Value(PayOutcome::NeedsApproval {
                receipt_id,
                pending_id,
                expires_at_ns,
            }) => {
                assert_eq!(expires_at_ns, U64(T0 + DAY_NS));
                (receipt_id, pending_id)
            }
            _ => panic!("expected needs_approval"),
        };
        assert_eq!(vault.get_pending().len(), 1);
        assert_eq!(
            vault.get_receipt(receipt_id).unwrap().status,
            ReceiptStatus::Pending
        );
        // Nothing is reserved while the request waits.
        assert_eq!(
            vault.get_agent_state(worker()).unwrap().spent_in_window,
            near(0)
        );

        // The second approver may approve; the policy is re-checked and the budget reserved.
        set_caller(acc("approver.test"), T0 + 60 * NS_PER_SEC);
        let outcome = vault.approve(pending_id);
        assert!(matches!(outcome, PromiseOrValue::Promise(_)));
        assert!(vault.get_pending().is_empty());
        let receipt = vault.get_receipt(receipt_id).unwrap();
        assert_eq!(receipt.status, ReceiptStatus::Approved);
        assert_eq!(receipt.approved_by, Some(acc("approver.test")));
        assert_eq!(receipt.pending_id, Some(pending_id));
        assert_eq!(
            vault.get_agent_state(worker()).unwrap().spent_in_window,
            millinear(800)
        );
        assert!(
            events()
                .iter()
                .any(|e| e.contains("\"event\":\"approval_granted\""))
        );

        set_caller(vault_id(), T0 + 61 * NS_PER_SEC);
        vault.settle_payment(
            receipt_id,
            worker(),
            millinear(800),
            U64(T0 - T0 % DAY_NS),
            true,
        );
        assert_eq!(
            vault.get_receipt(receipt_id).unwrap().status,
            ReceiptStatus::Paid
        );
    }

    #[test]
    fn approval_re_evaluates_the_policy_at_execution_time() {
        let mut vault = vault_with_worker();
        set_caller(acc("worker.test"), T0);
        let pending_id = match vault.pay(api(), millinear(800), None, None, None) {
            PromiseOrValue::Value(PayOutcome::NeedsApproval { pending_id, .. }) => pending_id,
            _ => panic!("expected needs_approval"),
        };
        set_caller(owner(), T0 + 1);
        vault.pause();
        match vault.approve(pending_id) {
            PromiseOrValue::Value(PayOutcome::Rejected { reason, .. }) => {
                assert_eq!(reason, Rejection::Paused)
            }
            _ => panic!("expected a rejection"),
        }
        assert!(vault.get_pending().is_empty());
        assert_eq!(
            vault.get_receipt(1).unwrap().status,
            ReceiptStatus::Rejected {
                reason: Rejection::Paused
            }
        );
    }

    #[test]
    fn denied_and_expired_requests() {
        let mut vault = vault_with_worker();
        set_caller(acc("worker.test"), T0);
        let _ = vault.pay(api(), millinear(800), None, None, None); // pending 0 / receipt 1
        let _ = vault.pay(api(), millinear(700), None, None, None); // pending 1 / receipt 2
        let _ = vault.pay(api(), millinear(600), None, None, None); // pending 2 / receipt 3
        assert_eq!(vault.get_pending().len(), 3);

        set_caller(owner(), T0 + 1);
        vault.deny(0);
        assert_eq!(vault.get_receipt(1).unwrap().status, ReceiptStatus::Denied);

        // Not yet expired: nobody can sweep it.
        set_caller(acc("anyone.test"), T0 + DAY_NS - 1);
        assert!(vault.get_pending_by_id(1).is_some());

        // Expired: anyone can sweep, and approve/deny mark it expired too.
        set_caller(acc("anyone.test"), T0 + DAY_NS);
        assert!(vault.expire_pending(1));
        assert_eq!(vault.get_receipt(2).unwrap().status, ReceiptStatus::Expired);
        set_caller(owner(), T0 + DAY_NS);
        match vault.approve(2) {
            PromiseOrValue::Value(PayOutcome::Expired {
                receipt_id,
                pending_id,
            }) => {
                assert_eq!((receipt_id, pending_id), (3, 2));
            }
            _ => panic!("expected expired"),
        }
        assert!(vault.get_pending().is_empty());
        assert!(
            events()
                .iter()
                .any(|e| e.contains("\"event\":\"approval_expired\""))
        );
    }

    #[test]
    #[should_panic(expected = "approval request has not expired yet")]
    fn live_requests_cannot_be_swept() {
        let mut vault = vault_with_worker();
        set_caller(acc("worker.test"), T0);
        let _ = vault.pay(api(), millinear(800), None, None, None);
        set_caller(acc("anyone.test"), T0 + 1);
        vault.expire_pending(0);
    }

    #[test]
    #[should_panic(expected = "only the owner or the approver can call this method")]
    fn strangers_cannot_approve() {
        let mut vault = vault_with_worker();
        set_caller(acc("worker.test"), T0);
        let _ = vault.pay(api(), millinear(800), None, None, None);
        set_caller(acc("mallory.test"), T0 + 1);
        let _ = vault.approve(0);
    }

    #[test]
    fn kill_pauses_forgets_agents_and_denies_the_queue() {
        let mut vault = vault_with_worker();
        set_caller(acc("worker.test"), T0);
        let _ = vault.pay(api(), millinear(800), None, None, None);
        set_caller(owner(), T0 + 1);
        let removed = vault.kill();
        assert_eq!(removed, vec![worker()]);
        assert!(vault.get_vault().paused);
        assert_eq!(vault.get_vault().agents, 0);
        assert!(vault.get_pending().is_empty());
        assert_eq!(vault.get_receipt(1).unwrap().status, ReceiptStatus::Denied);
        assert!(
            events()
                .iter()
                .any(|e| e.contains("\"event\":\"vault_killed\""))
        );
        // The receipt history survives the kill.
        assert_eq!(vault.get_receipts(None, None).len(), 2);
    }

    #[test]
    fn pause_disable_and_policy_updates() {
        let mut vault = vault_with_worker();
        set_caller(owner(), T0);
        vault.pause();
        set_caller(acc("worker.test"), T0);
        assert_eq!(
            vault.simulate(None, api(), millinear(1), None).reason,
            Some(Rejection::Paused)
        );
        set_caller(owner(), T0);
        vault.unpause();
        vault.disable_agent(worker());
        set_caller(acc("worker.test"), T0);
        assert_eq!(
            vault.simulate(None, api(), millinear(1), None).reason,
            Some(Rejection::AgentDisabled)
        );
        set_caller(owner(), T0);
        vault.enable_agent(worker());
        let mut p = policy();
        p.per_tx_cap = millinear(100);
        p.approval_threshold = None;
        assert_eq!(vault.set_policy(worker(), p), 2);
        set_caller(acc("worker.test"), T0);
        assert_eq!(
            vault.simulate(None, api(), millinear(200), None).reason,
            Some(Rejection::OverPerTxCap {
                cap: millinear(100)
            })
        );
        assert_eq!(vault.get_agent(worker()).unwrap().policy_version, 2);
    }

    #[test]
    fn remove_agent_denies_its_queue() {
        let mut vault = vault_with_worker();
        set_caller(acc("worker.test"), T0);
        let _ = vault.pay(api(), millinear(800), None, None, None);
        set_caller(owner(), T0);
        let _ = vault.remove_agent(worker());
        assert!(vault.get_agent(worker()).is_none());
        assert!(vault.get_pending().is_empty());
        assert_eq!(vault.get_receipt(1).unwrap().status, ReceiptStatus::Denied);
    }

    #[test]
    fn withdraw_keeps_the_storage_reserve() {
        let mut vault = vault_with_worker();
        set_caller(owner(), T0);
        let available = vault.get_vault().available;
        assert!(available < near(10) && available > near(9));
        let _ = vault.withdraw(available, None);
        let receipt = vault.get_receipt(1).unwrap();
        assert_eq!(receipt.kind, ReceiptKind::Refund);
        assert_eq!(receipt.payee, owner());
    }

    #[test]
    #[should_panic(expected = "amount exceeds the balance available")]
    fn withdraw_cannot_eat_the_storage_reserve() {
        let mut vault = vault_with_worker();
        set_caller(owner(), T0);
        let _ = vault.withdraw(near(10), None);
    }

    #[test]
    fn prune_receipts_keeps_pending_ones() {
        let mut vault = vault_with_worker();
        set_caller(acc("worker.test"), T0);
        let _ = vault.pay(acc("nobody.test"), millinear(1), None, None, None); // 1 rejected
        let _ = vault.pay(api(), millinear(800), None, None, None); // 2 pending approval
        let _ = vault.pay(acc("nobody.test"), millinear(1), None, None, None); // 3 rejected
        set_caller(owner(), T0);
        assert_eq!(vault.prune_receipts(10, None), 2);
        let info = vault.get_vault();
        assert_eq!(info.first_receipt_id, 2);
        assert!(vault.get_receipt(0).is_none());
        assert!(vault.get_receipt(2).is_some());
        assert_eq!(vault.get_receipts(None, None).len(), 2);
    }

    // ------------------------------------------------------------------
    // NEP-141 payments
    // ------------------------------------------------------------------

    fn token() -> AccountId {
        acc("usd.test")
    }
    fn usd_worker() -> AgentId {
        AgentId::Account(acc("usd-worker.test"))
    }
    /// A 6-decimal token, like USDC.
    fn usd(n: u128) -> NearToken {
        NearToken::from_yoctonear(n * 1_000_000)
    }

    /// cap 10 USD, 20 USD/day, allow [api], approval above 5 USD, may pay up
    /// to 0.01 NEAR to register a payee on the token.
    fn ft_policy() -> Policy {
        Policy {
            asset: Asset::Ft(token()),
            per_tx_cap: usd(10),
            budget: Some(Budget {
                amount: usd(20),
                period_ns: U64(DAY_NS),
            }),
            approval_threshold: Some(usd(5)),
            ft_storage_deposit: Some(millinear(10)),
            ..policy()
        }
    }

    /// Run a callback: the vault calls itself, with one promise result.
    fn set_callback(builder: VMContextBuilder, result: near_sdk::PromiseResult) {
        testing_env!(
            builder.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result],
        );
    }

    fn ok(bytes: &[u8]) -> near_sdk::PromiseResult {
        near_sdk::PromiseResult::Successful(bytes.to_vec())
    }

    /// `vault_with_worker` + the token registered + 100 USD deposited with
    /// `ft_transfer_call` (receipt #1) + a token agent "usd-worker".
    fn vault_with_usd_worker() -> Vault {
        let mut vault = vault_with_worker();
        set_caller(owner(), T0);
        vault.register_token(token(), None);
        set_caller(token(), T0);
        match vault.ft_on_transfer(owner(), U128(usd(100).as_yoctonear()), "seed".into()) {
            PromiseOrValue::Value(U128(0)) => {}
            _ => panic!("the deposit should be kept"),
        }
        set_caller(owner(), T0);
        let _ = vault.add_agent(usd_worker(), "usd".into(), ft_policy(), None);
        vault
    }

    fn token_balance(vault: &Vault) -> NearToken {
        NearToken::from_yoctonear(vault.get_token(token()).unwrap().balance.0)
    }

    /// The token agent pays `amount` to api; returns the receipt id and the
    /// budget window the reservation was made in.
    fn usd_pay(vault: &mut Vault, amount: NearToken) -> (u64, U64) {
        set_caller(acc("usd-worker.test"), T0);
        let out = vault.pay(
            api(),
            amount,
            Some(Asset::Ft(token())),
            Some("candles".into()),
            None,
        );
        assert!(matches!(out, PromiseOrValue::Promise(_)));
        let id = vault.get_vault().next_receipt_id - 1;
        let window = vault.get_agent_state(usd_worker()).unwrap().window_start_ns;
        (id, window)
    }

    #[test]
    fn tokens_are_credited_only_from_registered_contracts() {
        let mut vault = vault_with_worker();
        set_caller(token(), T0);
        // Not registered yet: the token is told to refund all of it.
        assert!(matches!(
            vault.ft_on_transfer(owner(), U128(5), String::new()),
            PromiseOrValue::Value(U128(5))
        ));
        set_caller(owner(), T0);
        vault.register_token(token(), Some(U128(1_000)));
        set_caller(token(), T0);
        assert!(
            matches!(
                vault.ft_on_transfer(owner(), U128(999), String::new()),
                PromiseOrValue::Value(U128(999))
            ),
            "dust below min_deposit is refunded"
        );
        assert!(matches!(
            vault.ft_on_transfer(
                acc("customer.test"),
                U128(usd(3).as_yoctonear()),
                "invoice 7".into()
            ),
            PromiseOrValue::Value(U128(0))
        ));
        let receipt = vault.get_receipt(1).unwrap();
        assert_eq!(receipt.kind, ReceiptKind::Income);
        assert_eq!(receipt.asset, Asset::Ft(token()));
        assert_eq!(receipt.amount, usd(3));
        assert_eq!(receipt.agent, AgentId::Account(acc("customer.test")));
        assert_eq!(receipt.memo, "invoice 7");
        assert_eq!(token_balance(&vault), usd(3));
        assert_eq!(vault.get_vault().tokens.len(), 1);
        assert!(
            events()
                .iter()
                .any(|e| e.contains("\"event\":\"vault_funded\"")
                    && e.contains("\"ft\":\"usd.test\""))
        );
        // Anyone can call ft_on_transfer, but it only ever credits the
        // caller's own token, and unregistered callers get everything back.
        set_caller(acc("fake-token.test"), T0);
        assert!(matches!(
            vault.ft_on_transfer(owner(), U128(10_000_000), String::new()),
            PromiseOrValue::Value(U128(10_000_000))
        ));
        assert_eq!(token_balance(&vault), usd(3));
    }

    #[test]
    #[should_panic(expected = "register the token first")]
    fn token_policies_need_a_registered_token() {
        set_caller(owner(), T0);
        let mut vault = Vault::new(owner(), None, None, None);
        let _ = vault.add_agent(usd_worker(), "usd".into(), ft_policy(), None);
    }

    #[test]
    fn token_payment_to_a_registered_payee() {
        let mut vault = vault_with_usd_worker();
        let ft = Asset::Ft(token());
        set_caller(acc("usd-worker.test"), T0);
        let sim = vault.simulate(None, api(), usd(2), Some(ft.clone()));
        assert_eq!(sim.verdict, Verdict::Allow);
        assert_eq!(sim.vault_available, usd(100), "in token units");
        assert_eq!(sim.remaining_budget, Some(usd(20)));
        assert_eq!(
            vault
                .simulate(None, api(), usd(6), Some(ft.clone()))
                .verdict,
            Verdict::NeedsApproval
        );
        assert_eq!(
            vault.simulate(None, api(), usd(2), None).reason,
            Some(Rejection::AssetNotAllowed {
                allowed: ft.clone()
            }),
            "a token agent cannot pay NEAR"
        );

        let (id, window) = usd_pay(&mut vault, usd(2));
        assert_eq!(id, 2);
        // Tokens and budget are reserved before any cross-contract call.
        assert_eq!(token_balance(&vault), usd(98));
        assert_eq!(
            vault.get_agent_state(usd_worker()).unwrap().spent_in_window,
            usd(2)
        );

        // storage_balance_of(api): registered.
        set_callback(
            context(vault_id(), T0 + 1),
            ok(br#"{"total":"1250000000000000000000","available":"0"}"#),
        );
        let next =
            vault.on_ft_storage_checked(id, usd_worker(), usd(2), window, Some(millinear(10)));
        assert!(matches!(next, PromiseOrValue::Promise(_)));
        assert_eq!(vault.get_receipt(id).unwrap().storage_deposit, None);

        // ft_transfer succeeded.
        set_callback(context(vault_id(), T0 + 2), ok(b""));
        assert_eq!(
            vault.on_paid(id, usd_worker(), usd(2), window),
            PayOutcome::Paid { receipt_id: id }
        );
        assert!(vault.verify_receipt(id, api(), usd(2), None, Some(ft.clone())));
        assert!(
            !vault.verify_receipt(id, api(), usd(2), None, None),
            "a token receipt never verifies as a NEAR payment"
        );
        assert!(
            events()
                .iter()
                .any(|e| e.contains("\"event\":\"payment_paid\"") && e.contains("usd.test"))
        );
        assert_eq!(token_balance(&vault), usd(98));
    }

    #[test]
    fn unregistered_payees_are_registered_only_if_the_policy_allows() {
        let mut vault = vault_with_usd_worker();
        set_caller(owner(), T0);
        let mut no_storage = ft_policy();
        no_storage.ft_storage_deposit = None;
        vault.set_policy(usd_worker(), no_storage);

        let (id, window) = usd_pay(&mut vault, usd(2));
        set_callback(context(vault_id(), T0 + 1), ok(b"null"));
        let reason = Failure::PayeeNotRegistered;
        match vault.on_ft_storage_checked(id, usd_worker(), usd(2), window, None) {
            PromiseOrValue::Value(outcome) => assert_eq!(
                outcome,
                PayOutcome::Failed {
                    receipt_id: id,
                    reason
                }
            ),
            _ => panic!("expected a failure value"),
        }
        assert_eq!(
            vault.get_receipt(id).unwrap().status,
            ReceiptStatus::Failed { reason }
        );
        assert_eq!(token_balance(&vault), usd(100), "tokens released");
        assert_eq!(
            vault.get_agent_state(usd_worker()).unwrap().spent_in_window,
            usd(0),
            "budget released"
        );
        assert!(events().iter().any(|e| e.contains("payee_not_registered")));

        // With ft_storage_deposit the vault registers the payee first.
        set_caller(owner(), T0);
        vault.set_policy(usd_worker(), ft_policy());
        let (id, window) = usd_pay(&mut vault, usd(2));
        set_callback(context(vault_id(), T0 + 1), ok(b"null"));
        let next =
            vault.on_ft_storage_checked(id, usd_worker(), usd(2), window, Some(millinear(10)));
        assert!(matches!(next, PromiseOrValue::Promise(_)));
        assert_eq!(
            vault.get_receipt(id).unwrap().storage_deposit,
            Some(millinear(10))
        );
        assert!(
            events()
                .iter()
                .any(|e| e.contains("\"event\":\"ft_payee_registration\""))
        );
        // ...and if the transfer fails after all, everything is released.
        set_callback(context(vault_id(), T0 + 2), near_sdk::PromiseResult::Failed);
        let reason = Failure::FtTransferFailed;
        assert_eq!(
            vault.on_paid(id, usd_worker(), usd(2), window),
            PayOutcome::Failed {
                receipt_id: id,
                reason
            }
        );
        assert_eq!(token_balance(&vault), usd(100));

        // Not enough NEAR above the storage reserve to register the payee.
        let (id, window) = usd_pay(&mut vault, usd(2));
        let poor = {
            let mut b = context(vault_id(), T0 + 3);
            b.account_balance(millinear(115)); // reserve is 0.1 + 0.01 NEAR
            b
        };
        set_callback(poor, ok(b"null"));
        match vault.on_ft_storage_checked(id, usd_worker(), usd(2), window, Some(millinear(10))) {
            PromiseOrValue::Value(PayOutcome::Failed { reason, .. }) => {
                assert_eq!(reason, Failure::InsufficientNearForStorage)
            }
            _ => panic!("expected a failure value"),
        }
        assert_eq!(token_balance(&vault), usd(100));
    }

    #[test]
    fn a_broken_storage_check_fails_the_payment_cleanly() {
        let mut vault = vault_with_usd_worker();
        for result in [ok(b"not json"), near_sdk::PromiseResult::Failed] {
            let (id, window) = usd_pay(&mut vault, usd(1));
            set_callback(context(vault_id(), T0 + 1), result);
            match vault.on_ft_storage_checked(id, usd_worker(), usd(1), window, Some(millinear(10)))
            {
                PromiseOrValue::Value(PayOutcome::Failed { reason, .. }) => {
                    assert_eq!(reason, Failure::StorageCheckFailed)
                }
                _ => panic!("expected a failure value"),
            }
        }
        assert_eq!(token_balance(&vault), usd(100));
    }

    #[test]
    fn token_withdrawals_settle_in_a_callback() {
        let mut vault = vault_with_usd_worker();
        set_caller(owner(), T0);
        let _ = vault.withdraw_ft(token(), U128(usd(10).as_yoctonear()), None);
        assert_eq!(token_balance(&vault), usd(90));
        let receipt = vault.get_receipt(2).unwrap();
        assert_eq!(receipt.kind, ReceiptKind::Refund);
        assert_eq!(receipt.status, ReceiptStatus::Pending);
        // The owner is not registered on the token: credited back.
        set_callback(context(vault_id(), T0 + 1), near_sdk::PromiseResult::Failed);
        assert!(!vault.on_ft_withdrawn(2));
        assert_eq!(token_balance(&vault), usd(100));
        assert_eq!(
            vault.get_receipt(2).unwrap().status,
            ReceiptStatus::Failed {
                reason: Failure::FtTransferFailed
            }
        );
        set_caller(owner(), T0 + 2);
        let _ = vault.withdraw_ft(
            token(),
            U128(usd(10).as_yoctonear()),
            Some(acc("cold.test")),
        );
        set_callback(context(vault_id(), T0 + 3), ok(b""));
        assert!(vault.on_ft_withdrawn(3));
        assert_eq!(vault.get_receipt(3).unwrap().status, ReceiptStatus::Paid);
        assert_eq!(token_balance(&vault), usd(90));
    }

    #[test]
    #[should_panic(expected = "amount exceeds the vault's token balance")]
    fn token_withdrawals_cannot_exceed_the_accounted_balance() {
        let mut vault = vault_with_usd_worker();
        set_caller(owner(), T0);
        let _ = vault.withdraw_ft(token(), U128(usd(101).as_yoctonear()), None);
    }

    #[test]
    fn ping_identifies_the_caller() {
        let vault = vault_with_worker();
        set_caller(acc("worker.test"), T0);
        let pong = vault.ping();
        assert!(pong.registered);
        assert_eq!(pong.label.as_deref(), Some("worker"));
        set_caller(acc("stranger.test"), T0);
        assert!(!vault.ping().registered);
    }
}
