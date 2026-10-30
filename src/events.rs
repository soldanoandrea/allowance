//! NEP-297 events. Every state change that matters to the owner, the agent or
//! a ledger page is logged as `EVENT_JSON:{"standard":"allowance","version":"...","event":"...","data":{...}}`.
//!
//! Version 1.1.0 of the money events adds `asset` (`"near"` or
//! `{"ft": "<token>"}`); amounts are in that asset's smallest unit.

use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, NearToken, near};

use crate::policy::{Asset, Rejection};
use crate::split::Split;
use crate::types::{AgentId, Failure};

#[near(event_json(standard = "allowance"))]
pub enum Event {
    #[event_version("1.1.0")]
    VaultFunded {
        from: AccountId,
        amount: NearToken,
        asset: Asset,
        receipt_id: u64,
    },
    #[event_version("1.1.0")]
    Withdrawn {
        to: AccountId,
        amount: NearToken,
        asset: Asset,
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
    #[event_version("1.1.0")]
    PaymentPaid {
        receipt_id: u64,
        agent: AgentId,
        payee: AccountId,
        amount: NearToken,
        asset: Asset,
    },
    #[event_version("1.1.0")]
    PaymentFailed {
        receipt_id: u64,
        agent: AgentId,
        payee: AccountId,
        amount: NearToken,
        asset: Asset,
        reason: Failure,
    },
    #[event_version("1.1.0")]
    PaymentRejected {
        receipt_id: u64,
        agent: AgentId,
        payee: AccountId,
        amount: NearToken,
        asset: Asset,
        reason: Rejection,
    },
    #[event_version("1.1.0")]
    ApprovalRequested {
        pending_id: u64,
        receipt_id: u64,
        agent: AgentId,
        payee: AccountId,
        amount: NearToken,
        asset: Asset,
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
    /// The owner listed a NEP-141 token the vault accepts and pays in.
    #[event_version("1.0.0")]
    TokenRegistered {
        token_id: AccountId,
        min_deposit: U128,
    },
    /// The vault is registering a payee on a token before paying it
    /// (`storage_deposit`, NEP-145), as the agent's policy allows.
    /// The owner set or removed the revenue split.
    #[event_version("1.0.0")]
    SplitSet { split: Option<Split> },
    /// A revenue-split share of an income receipt reached its beneficiary
    /// (`paid: true`) or stayed in the vault (`paid: false`).
    #[event_version("1.0.0")]
    SplitSettled {
        receipt_id: u64,
        beneficiary: AccountId,
        amount: NearToken,
        asset: Asset,
        paid: bool,
    },
    #[event_version("1.0.0")]
    FtPayeeRegistration {
        receipt_id: u64,
        token_id: AccountId,
        payee: AccountId,
        attached: NearToken,
    },
}
