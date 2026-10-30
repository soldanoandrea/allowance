/**
 * JSON shapes of the Allowance contract (src/types.rs, src/policy.rs,
 * src/events.rs). Conventions of the contract's JSON:
 *
 * - amounts are `NearToken` -> decimal strings of yoctoNEAR (`Yocto`);
 * - timestamps ending in `_ns` are `U64` -> decimal strings of nanoseconds
 *   since the epoch (`Ns`), because JSON numbers lose precision above 2^53;
 * - receipt and approval ids are plain JSON numbers (`u64`, small);
 * - enums are snake_case; tagged enums use `code` (Rejection), `status`
 *   (ReceiptStatus) and `outcome` (PayOutcome).
 */

/** yoctoNEAR as a decimal string (1 NEAR = 10^24 yocto). */
export type Yocto = string;
/** Nanoseconds since the Unix epoch as a decimal string. */
export type Ns = string;

/** A function-call key on the vault account, or an agent that owns an account. */
export type AgentId = { key: string } | { account: string };

export type Asset = 'near' | { ft: string };

export interface Budget {
  amount: Yocto;
  period_ns: Ns;
}

export interface AllowEntry {
  account_id: string;
  methods?: string[] | null;
}

export type Allow = 'any' | { list: AllowEntry[] };

export interface TimeWindow {
  start_h: number;
  end_h: number;
  days?: number[];
}

export interface Policy {
  asset?: Asset;
  per_tx_cap: Yocto;
  budget?: Budget | null;
  allow?: Allow;
  time_window?: TimeWindow | null;
  cooldown_ns?: Ns;
  approval_threshold?: Yocto | null;
  expires_at_ns?: Ns | null;
}

export interface SpendState {
  window_start_ns: Ns;
  spent_in_window: Yocto;
  last_payment_ns: Ns;
  payments: number;
}

/** Why the policy refused a payment (first failing check wins). */
export type Rejection =
  | { code: 'paused' }
  | { code: 'agent_disabled' }
  | { code: 'policy_expired'; expired_at_ns: Ns }
  | { code: 'asset_not_allowed'; allowed: Asset }
  | { code: 'denylisted'; payee: string }
  | { code: 'not_allowlisted'; payee: string }
  | { code: 'over_per_tx_cap'; cap: Yocto }
  | { code: 'outside_time_window'; opens_at_ns: Ns }
  | { code: 'cooldown'; retry_at_ns: Ns }
  | { code: 'over_budget'; remaining: Yocto; resets_at_ns: Ns }
  | { code: 'insufficient_vault_balance'; available: Yocto }
  | { code: 'unknown_agent' };

export type ReceiptStatus =
  | { status: 'paid' }
  | { status: 'rejected'; reason: Rejection }
  | { status: 'pending' }
  | { status: 'approved' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'failed' };

export type ReceiptKind = 'pay' | 'income' | 'refund';

export interface Receipt {
  id: number;
  kind: ReceiptKind;
  status: ReceiptStatus;
  agent: AgentId;
  payee: string;
  amount: Yocto;
  asset: Asset;
  memo: string;
  request_hash: string | null;
  ts_ns: Ns;
  policy_version: number;
  delivered: boolean | null;
  pending_id: number | null;
  approved_by: string | null;
}

export interface Pending {
  id: number;
  receipt_id: number;
  agent: AgentId;
  payee: string;
  amount: Yocto;
  asset: Asset;
  memo: string;
  request_hash: string | null;
  created_at_ns: Ns;
  expires_at_ns: Ns;
}

/** Final value of a `pay` (or `approve`) transaction. */
export type PayOutcome =
  | { outcome: 'paid'; receipt_id: number }
  | { outcome: 'failed'; receipt_id: number }
  | { outcome: 'needs_approval'; receipt_id: number; pending_id: number; expires_at_ns: Ns }
  | { outcome: 'rejected'; receipt_id: number; reason: Rejection }
  | { outcome: 'expired'; receipt_id: number; pending_id: number };

export type Verdict = 'allow' | 'needs_approval' | 'block';

/** Answer of the free `simulate` view. */
export interface Simulation {
  verdict: Verdict;
  reason: Rejection | null;
  agent: AgentId;
  policy_version: number;
  remaining_budget: Yocto | null;
  budget_resets_at_ns: Ns | null;
  vault_available: Yocto;
  block_timestamp_ns: Ns;
}

export interface VaultInfo {
  owner_id: string;
  approver_id: string | null;
  paused: boolean;
  balance: Yocto;
  available: Yocto;
  storage_usage_bytes: number;
  agents: number;
  next_receipt_id: number;
  first_receipt_id: number;
  pending: number;
  approval_ttl_ns: Ns;
  key_gas_allowance: Yocto;
  block_timestamp_ns: Ns;
  version: string;
}

export interface AgentView {
  id: AgentId;
  label: string;
  policy: Policy;
  state: SpendState;
  active: boolean;
  policy_version: number;
  added_at_ns: Ns;
  remaining_budget: Yocto | null;
  budget_resets_at_ns: Ns | null;
}

export interface PingResponse {
  agent: AgentId;
  registered: boolean;
  label: string | null;
  active: boolean;
  paused: boolean;
  block_timestamp_ns: Ns;
}

/** A NEP-297 event logged by the vault (`EVENT_JSON:{...}`). */
export interface AllowanceEvent {
  standard: 'allowance';
  version: string;
  event: string;
  data: Record<string, unknown>;
}
