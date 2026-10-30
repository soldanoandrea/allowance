//! Allowance: a sandboxed treasury for AI agents on NEAR.
//!
//! A human owner funds this contract, writes a spending policy on-chain and
//! registers agents as **function-call access keys on the vault account
//! itself**. The protocol limits what such a key can do (only `pay`,
//! `confirm_delivery` and `ping` on this contract, within a gas allowance,
//! never attaching deposits); the contract limits how much money moves, to
//! whom and when. Every payment, rejection and approval leaves a receipt and a
//! NEP-297 event.
//!
//! Trust model: the owner is `owner_id` (checked on `predecessor_account_id`),
//! never "whoever holds a key on this account". Agents are identified by
//! their key (`signer_account_pk`) when they call from the vault account, or
//! by their own account otherwise.

pub mod events;
pub mod policy;
pub mod types;

use near_sdk::json_types::{Base64VecU8, U64};
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, PublicKey, env, near, require,
};

use events::Event;
use policy::{Asset, Decision, EvalContext, NS_PER_SEC, PayRequest, Policy, Rejection, evaluate};
use types::{
    Agent, AgentId, AgentView, PayOutcome, Pending, PingResponse, Receipt, ReceiptKind,
    ReceiptStatus, Simulation, VaultInfo, Verdict,
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
const GAS_FOR_PAY_CALLBACK: Gas = Gas::from_tgas(5);
const GAS_FOR_KEY_CALLBACK: Gas = Gas::from_tgas(5);
const DEFAULT_PAGE: u64 = 50;

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Agents,
    Denylist,
    Receipts,
    Pending,
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
        });
        Event::VaultFunded {
            from,
            amount,
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
        });
        Event::Withdrawn {
            to: to.clone(),
            amount,
            receipt_id,
        }
        .emit();
        Promise::new(to).transfer(amount)
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
        if let Err(msg) = policy.validate() {
            env::panic_str(&format!("invalid policy: {msg}"));
        }
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
        if let Err(msg) = policy.validate() {
            env::panic_str(&format!("invalid policy: {msg}"));
        }
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
            vault_available: self.available_balance(),
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

    /// Agent: pay `amount` of NEAR to `payee` under the caller's policy.
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
            vault_available: self.available_balance(),
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
                        asset,
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
                self.transfer(agent_id, receipt_id, payee, amount)
            }
        }
    }

    /// Callback of the transfer issued by `pay`/`approve`: settles the
    /// receipt and, on failure, releases the budget reservation.
    #[private]
    pub fn on_paid(
        &mut self,
        receipt_id: u64,
        agent_id: AgentId,
        amount: NearToken,
        window_start_ns: U64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> PayOutcome {
        let payee = self
            .receipts
            .get(&receipt_id)
            .map(|r| r.payee.clone())
            .unwrap_or_else(|| env::panic_str("receipt missing in callback"));
        match result {
            Ok(()) => {
                self.update_receipt(receipt_id, |r| r.status = ReceiptStatus::Paid);
                Event::PaymentPaid {
                    receipt_id,
                    agent: agent_id,
                    payee,
                    amount,
                }
                .emit();
                PayOutcome::Paid { receipt_id }
            }
            Err(_) => {
                self.update_receipt(receipt_id, |r| r.status = ReceiptStatus::Failed);
                if let Some(agent) = self.agents.get_mut(&agent_id) {
                    agent.state.release(amount, window_start_ns.0);
                }
                Event::PaymentFailed {
                    receipt_id,
                    agent: agent_id,
                    payee,
                    amount,
                }
                .emit();
                PayOutcome::Failed { receipt_id }
            }
        }
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
        let vault_available = self.available_balance();
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
        let asset = asset.unwrap_or_default();
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
    /// `payee` of at least `min_amount`, bound to `request_hash` if given?
    pub fn verify_receipt(
        &self,
        receipt_id: u64,
        payee: AccountId,
        min_amount: NearToken,
        request_hash: Option<Base64VecU8>,
    ) -> bool {
        let Some(receipt) = self.receipts.get(&receipt_id) else {
            return false;
        };
        receipt.kind == ReceiptKind::Pay
            && receipt.status == ReceiptStatus::Paid
            && receipt.payee == payee
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

    /// Reserve the budget and issue the transfer with its settlement callback.
    fn transfer(
        &mut self,
        agent_id: AgentId,
        receipt_id: u64,
        payee: AccountId,
        amount: NearToken,
    ) -> PromiseOrValue<PayOutcome> {
        let now = env::block_timestamp();
        let window_start_ns = {
            let agent = self.agent_mut(&agent_id);
            agent
                .state
                .record_payment(agent.policy.budget.as_ref(), amount, now);
            agent.state.window_start_ns
        };
        PromiseOrValue::Promise(
            Promise::new(payee).transfer(amount).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_PAY_CALLBACK)
                    .on_paid(receipt_id, agent_id, amount, window_start_ns),
            ),
        )
    }
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
        assert!(!vault.verify_receipt(1, api(), millinear(20), None));

        set_caller(vault_id(), T0 + 1);
        let settled = vault.on_paid(1, worker(), millinear(20), state.window_start_ns, Ok(()));
        assert_eq!(settled, PayOutcome::Paid { receipt_id: 1 });
        assert!(vault.verify_receipt(1, api(), millinear(20), Some(hash)));
        assert!(vault.verify_receipt(1, api(), millinear(10), None));
        assert!(
            !vault.verify_receipt(1, api(), millinear(21), None),
            "amount too small"
        );
        assert!(
            !vault.verify_receipt(1, acc("other.test"), millinear(20), None),
            "wrong payee"
        );
        assert!(
            !vault.verify_receipt(1, api(), millinear(20), Some(Base64VecU8(vec![8u8; 32]))),
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
        vault.on_paid(1, worker(), millinear(20), U64(T0), Ok(()));
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
        vault.on_paid(1, worker(), millinear(20), U64(T0), Ok(()));
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
        let settled = vault.on_paid(
            1,
            worker(),
            millinear(20),
            window,
            Err(PromiseError::Failed),
        );
        assert_eq!(settled, PayOutcome::Failed { receipt_id: 1 });
        assert_eq!(vault.get_receipt(1).unwrap().status, ReceiptStatus::Failed);
        assert_eq!(
            vault.get_agent_state(worker()).unwrap().spent_in_window,
            near(0)
        );
        assert!(!vault.verify_receipt(1, api(), millinear(20), None));
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
        vault.on_paid(
            receipt_id,
            worker(),
            millinear(800),
            U64(T0 - T0 % DAY_NS),
            Ok(()),
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
