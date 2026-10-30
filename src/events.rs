//! NEP-297 events. Every state change that matters to the owner, the agent or
//! a ledger page is logged as `EVENT_JSON:{"standard":"allowance","version":"1.0.0","event":"...","data":{...}}`.

use near_sdk::json_types::U64;
use near_sdk::{AccountId, NearToken, near};

use crate::policy::Rejection;
use crate::types::AgentId;

#[near(event_json(standard = "allowance"))]
pub enum Event {
    #[event_version("1.0.0")]
    VaultFunded {
        from: AccountId,
        amount: NearToken,
        receipt_id: u64,
    },
    #[event_version("1.0.0")]
    Withdrawn {
        to: AccountId,
        amount: NearToken,
        receipt_id: u64,
    },
    #[event_version("1.0.0")]
    AgentAdded {
        agent: AgentId,
        label: String,
        policy_version: u32,
    },
    #[event_version("1.0.0")]
    AgentRemoved { agent: AgentId },
    #[event_version("1.0.0")]
    AgentDisabled { agent: AgentId },
    #[event_version("1.0.0")]
    AgentEnabled { agent: AgentId },
    #[event_version("1.0.0")]
    PolicySet { agent: AgentId, policy_version: u32 },
    #[event_version("1.0.0")]
    KeyAllowanceToppedUp {
        agent: AgentId,
        allowance: NearToken,
    },
    #[event_version("1.0.0")]
    PaymentPaid {
        receipt_id: u64,
        agent: AgentId,
        payee: AccountId,
        amount: NearToken,
    },
    #[event_version("1.0.0")]
    PaymentFailed {
        receipt_id: u64,
        agent: AgentId,
        payee: AccountId,
        amount: NearToken,
    },
    #[event_version("1.0.0")]
    PaymentRejected {
        receipt_id: u64,
        agent: AgentId,
        payee: AccountId,
        amount: NearToken,
        reason: Rejection,
    },
    #[event_version("1.0.0")]
    ApprovalRequested {
        pending_id: u64,
        receipt_id: u64,
        agent: AgentId,
        payee: AccountId,
        amount: NearToken,
        expires_at_ns: U64,
    },
    #[event_version("1.0.0")]
    ApprovalGranted {
        pending_id: u64,
        receipt_id: u64,
        approver: AccountId,
    },
    #[event_version("1.0.0")]
    ApprovalDenied {
        pending_id: u64,
        receipt_id: u64,
        approver: AccountId,
    },
    #[event_version("1.0.0")]
    ApprovalExpired { pending_id: u64, receipt_id: u64 },
    #[event_version("1.0.0")]
    DeliveryConfirmed {
        receipt_id: u64,
        agent: AgentId,
        passed: bool,
    },
    #[event_version("1.0.0")]
    DenylistSet { accounts: Vec<AccountId> },
    #[event_version("1.0.0")]
    VaultPaused { by: AccountId },
    #[event_version("1.0.0")]
    VaultUnpaused { by: AccountId },
    #[event_version("1.0.0")]
    VaultKilled { by: AccountId, agents: Vec<AgentId> },
}
