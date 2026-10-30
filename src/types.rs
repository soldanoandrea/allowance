//! Storage records and JSON views of the vault.

use near_sdk::json_types::{Base64VecU8, U64};
use near_sdk::{AccountId, NearToken, PublicKey, near};

use crate::policy::{Asset, Policy, Rejection, SpendState};

/// Identity of an agent.
///
/// * `Key` - a function-call access key that lives on the vault account
///   itself. Inside a call, `predecessor == current account` and the key is
///   `env::signer_account_pk()`. The agent needs no NEAR account.
/// * `Account` - an agent that already owns an account and calls the vault
///   from it (`predecessor_account_id`).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AgentId {
    Key(PublicKey),
    Account(AccountId),
}

/// A registered agent.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub label: String,
    pub policy: Policy,
    pub state: SpendState,
    pub active: bool,
    /// Incremented on every `set_policy`; receipts record the version they
    /// were evaluated under.
    pub policy_version: u32,
    pub added_at_ns: U64,
}

/// `Agent` plus its id and derived budget figures, for views.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AgentView {
    pub id: AgentId,
    pub label: String,
    pub policy: Policy,
    pub state: SpendState,
    pub active: bool,
    pub policy_version: u32,
    pub added_at_ns: U64,
    /// Budget left in the current window (`None` without a budget).
    pub remaining_budget: Option<NearToken>,
    /// When the current budget window resets (`None` without a budget).
    pub budget_resets_at_ns: Option<U64>,
}

impl AgentView {
    pub fn new(id: AgentId, agent: &Agent, now_ns: u64) -> Self {
        let budget = agent.policy.budget.as_ref();
        Self {
            id,
            label: agent.label.clone(),
            policy: agent.policy.clone(),
            state: agent.state.clone(),
            active: agent.active,
            policy_version: agent.policy_version,
            added_at_ns: agent.added_at_ns,
            remaining_budget: budget.map(|b| agent.state.remaining_at(b, now_ns)),
            budget_resets_at_ns: budget.map(|b| U64(b.resets_at(now_ns))),
        }
    }
}

/// Direction of a receipt.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptKind {
    /// Agent payment out of the vault.
    Pay,
    /// Deposit into the vault.
    Income,
    /// Funds returned to the owner (`withdraw`).
    Refund,
}

/// Lifecycle of a receipt. Serialized as `{"status": "...", ...}`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ReceiptStatus {
    /// Transfer confirmed by the callback.
    Paid,
    /// Refused by the policy; no transfer was created.
    Rejected { reason: Rejection },
    /// Transfer in flight, or waiting in the approval queue.
    Pending,
    /// Approved by a human; transfer in flight.
    Approved,
    /// Refused by a human.
    Denied,
    /// Approval request expired before a human acted.
    Expired,
    /// Transfer failed (e.g. payee account does not exist); budget released.
    Failed,
}

/// On-chain proof of a payment, deposit, rejection or withdrawal.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Receipt {
    pub id: u64,
    pub kind: ReceiptKind,
    pub status: ReceiptStatus,
    /// Paying agent; for `Income` receipts, the depositor.
    pub agent: AgentId,
    pub payee: AccountId,
    pub amount: NearToken,
    pub asset: Asset,
    pub memo: String,
    /// Opaque 32-byte hash supplied by the agent (e.g. sha256 of the HTTP
    /// request it is paying for) so a payee can bind a receipt to a request.
    pub request_hash: Option<Base64VecU8>,
    /// Block timestamp at which the receipt was created.
    pub ts_ns: U64,
    /// Policy version the payment was evaluated under (0 for non-agent receipts).
    pub policy_version: u32,
    /// Agent's own verdict on what it bought (`confirm_delivery`).
    pub delivered: Option<bool>,
    /// Approval queue entry, when the payment needed one.
    pub pending_id: Option<u64>,
    /// Human who approved the payment, when it needed one.
    pub approved_by: Option<AccountId>,
}

/// A payment waiting for human approval. No funds are reserved while pending;
/// the policy is re-evaluated at approval time.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Pending {
    pub id: u64,
    pub receipt_id: u64,
    pub agent: AgentId,
    pub payee: AccountId,
    pub amount: NearToken,
    pub asset: Asset,
    pub memo: String,
    pub request_hash: Option<Base64VecU8>,
    pub created_at_ns: U64,
    pub expires_at_ns: U64,
}

/// Return value of `pay`, `approve` and the transfer callback.
/// Serialized as `{"outcome": "...", ...}`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum PayOutcome {
    /// Transfer confirmed.
    Paid { receipt_id: u64 },
    /// Transfer failed; budget released.
    Failed { receipt_id: u64 },
    /// Parked in the approval queue.
    NeedsApproval {
        receipt_id: u64,
        pending_id: u64,
        expires_at_ns: U64,
    },
    /// Refused by the policy.
    Rejected { receipt_id: u64, reason: Rejection },
    /// The approval request had already expired.
    Expired { receipt_id: u64, pending_id: u64 },
}

/// Verdict of `simulate`.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Allow,
    NeedsApproval,
    Block,
}

/// Free dry-run of a payment.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Simulation {
    pub verdict: Verdict,
    /// Set when `verdict == block`.
    pub reason: Option<Rejection>,
    pub agent: AgentId,
    pub policy_version: u32,
    pub remaining_budget: Option<NearToken>,
    pub budget_resets_at_ns: Option<U64>,
    pub vault_available: NearToken,
    pub block_timestamp_ns: U64,
}

/// Vault summary.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VaultInfo {
    pub owner_id: AccountId,
    pub approver_id: Option<AccountId>,
    pub paused: bool,
    /// Total account balance.
    pub balance: NearToken,
    /// Balance minus the storage reserve: what the vault can actually pay out.
    pub available: NearToken,
    pub storage_usage_bytes: u64,
    pub agents: u32,
    /// Id the next receipt will get (receipts written so far, including pruned ones).
    pub next_receipt_id: u64,
    /// Oldest receipt still stored.
    pub first_receipt_id: u64,
    pub pending: u32,
    pub approval_ttl_ns: U64,
    pub key_gas_allowance: NearToken,
    pub block_timestamp_ns: U64,
    pub version: String,
}

/// Answer to `ping`: tells an agent who the vault thinks it is.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PingResponse {
    pub agent: AgentId,
    pub registered: bool,
    pub label: Option<String>,
    pub active: bool,
    pub paused: bool,
    pub block_timestamp_ns: U64,
}
