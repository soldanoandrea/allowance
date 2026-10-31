/**
 * JSON shapes of the Allowance contract (src/types.rs, src/policy.rs,
 * src/events.rs). Conventions of the contract's JSON:
 *
 * - amounts are `NearToken` -> decimal strings of base units (`Yocto`):
 *   yoctoNEAR, or the token's smallest unit when the asset is `{ft: ...}`;
 * - timestamps ending in `_ns` are `U64` -> decimal strings of nanoseconds
 *   since the epoch (`Ns`), because JSON numbers lose precision above 2^53;
 * - receipt and approval ids are plain JSON numbers (`u64`, small);
 * - enums are snake_case; tagged enums use `code` (Rejection), `status`
 *   (ReceiptStatus) and `outcome` (PayOutcome).
 */

/**
 * Base units as a decimal string: yoctoNEAR (1 NEAR = 10^24) for NEAR, the
 * token's smallest unit for a NEP-141 asset.
 */
export type Yocto = string;
/** Nanoseconds since the Unix epoch as a decimal string. */
export type Ns = string;

/** A function-call key on the vault account, or an agent that owns an account. */
export type AgentId = { key: string } | { account: string };

/** NEAR, or a NEP-141 token named by its contract account. */
export type Asset = 'near' | { ft: string };

export interface Budget {
  amount: Yocto;
  period_ns: Ns;
}

export interface AllowEntry {
  account_id: string;
  /** `["deposit"]`: the payee is another Allowance vault, paid through its `deposit` (its revenue split applies). */
  methods?: string[] | null;
}

/** Revenue split: shares of every income, in basis points (100 = 1%). */
export interface Split {
  beneficiaries: Array<{ account_id: string; bps: number }>;
}

export interface SplitPayout {
  account_id: string;
  bps: number;
  /** Base units of the income receipt's asset. */
  amount: Yocto;
  status: 'pending' | 'paid' | 'failed';
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
  /** NEP-141 policies: NEAR (yocto) the vault may attach to register an unregistered payee on the token. */
  ft_storage_deposit?: Yocto | null;
  /** The vault disables the agent after this many rejected payments in a row (1-100, default 5). */
  max_consecutive_rejections?: number;
  /** Most approval requests the agent may have open; one more disables it (1-100, default 3). */
  max_open_approvals?: number;
}

export interface SpendState {
  window_start_ns: Ns;
  spent_in_window: Yocto;
  last_payment_ns: Ns;
  payments: number;
  /** Rejected payments since the last one that went through. */
  consecutive_rejections?: number;
}

/** Why and when the vault disabled an agent on its own (cleared by `enable_agent`). */
export interface AutoDisabled {
  /** The rejection that tripped the limit. */
  reason: Rejection;
  consecutive_rejections: number;
  receipt_id: number;
  at_ns: Ns;
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
  | { code: 'unknown_agent' }
  | { code: 'too_many_open_approvals'; open: number; max: number };

export type ReceiptStatus =
  | { status: 'paid' }
  | { status: 'rejected'; reason: Rejection }
  | { status: 'pending' }
  | { status: 'approved' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'failed'; reason: Failure };

/** Why a payment that passed the policy did not reach the payee (budget and tokens released). */
export type Failure =
  | 'transfer_failed'
  | 'ft_transfer_failed'
  | 'payee_not_registered'
  | 'insufficient_near_for_storage'
  | 'storage_check_failed';

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
  /** NEP-141 payments: NEAR the vault attached to register the payee on the token. */
  storage_deposit: Yocto | null;
  /** Income receipts: revenue-split shares forwarded to beneficiaries. */
  split: SplitPayout[];
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
  | { outcome: 'failed'; receipt_id: number; reason: Failure }
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
  /** NEP-141 tokens the vault accepts, with the balance it accounts for. */
  tokens: TokenView[];
  /** Revenue split applied to every income, if any. */
  split: Split | null;
  block_timestamp_ns: Ns;
  version: string;
}

export interface TokenView {
  token_id: string;
  /** Base units the vault accounts for (credited by ft_on_transfer, debited by payments). */
  balance: string;
  min_deposit: string;
}

/** NEP-148 metadata of a token (the fields the SDK uses). */
export interface FtMetadata {
  spec: string;
  name: string;
  symbol: string;
  decimals: number;
}

export interface AgentView {
  id: AgentId;
  label: string;
  policy: Policy;
  state: SpendState;
  active: boolean;
  policy_version: number;
  added_at_ns: Ns;
  /** Set when the vault disabled the agent itself. */
  auto_disabled?: AutoDisabled | null;
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
