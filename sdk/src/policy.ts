import type { Policy } from './types.ts';
import { parseNear, parseUnits } from './units.ts';

const NS_PER_SEC = 1_000_000_000n;
const UNITS: Record<string, bigint> = { s: 1n, m: 60n, h: 3_600n, d: 86_400n, w: 604_800n };

/** "30s", "5m", "1h", "1d", "1w" -> nanoseconds (decimal string, the contract's U64). */
export function parseDuration(text: string): string {
  const match = /^(\d+)\s*([smhdw])$/.exec(text.trim());
  if (!match) throw new Error(`invalid duration ${JSON.stringify(text)} (expected e.g. "1d", "30s")`);
  return (BigInt(match[1] ?? '0') * (UNITS[match[2] ?? 's'] ?? 1n) * NS_PER_SEC).toString();
}

export interface PolicySpec {
  /**
   * Default NEAR. For a NEP-141 token give its contract and decimals; every
   * amount below (cap, budget, threshold) is then in that token ("2.5").
   */
  asset?: { ft: string; decimals: number };
  /** Hard ceiling for one payment ("1"). */
  perTxCap: string;
  /** Budget per window, e.g. { amount: "2", period: "1d" }. */
  budget?: { amount: string; period: string };
  /** Allowlisted payees; omit for "any" (the vault denylist still applies). */
  allow?: string[];
  /** Allowlisted Allowance vaults, paid through their `deposit` (their revenue split applies). */
  allowVaults?: string[];
  /** Above this amount (NEAR) a human approves. Must be below perTxCap. */
  approvalThreshold?: string;
  /** Minimum time between payments ("10s"). */
  cooldown?: string;
  timeWindow?: { startH: number; endH: number; days?: number[] };
  /** Expiry as a Date. */
  expiresAt?: Date;
  /** Token policies: NEAR the vault may attach to register a payee on the token ("0.01"). */
  ftStorageDeposit?: string;
  /** The vault disables the agent after this many rejected payments in a row (contract default 5). */
  maxConsecutiveRejections?: number;
  /** Most approval requests open at once; asking for one more disables the agent (contract default 3). */
  maxOpenApprovals?: number;
}

/** Build the contract's `Policy` JSON from human units. */
export function buildPolicy(spec: PolicySpec): Policy {
  const units = (amount: string): string => (spec.asset ? parseUnits(amount, spec.asset.decimals) : parseNear(amount)).toString();
  const policy: Policy = {
    asset: spec.asset ? { ft: spec.asset.ft } : 'near',
    per_tx_cap: units(spec.perTxCap),
    allow:
      spec.allow || spec.allowVaults
        ? {
            list: [
              ...(spec.allow ?? []).map((account_id) => ({ account_id })),
              ...(spec.allowVaults ?? []).map((account_id) => ({ account_id, methods: ['deposit'] })),
            ],
          }
        : 'any',
    cooldown_ns: spec.cooldown ? parseDuration(spec.cooldown) : '0',
  };
  if (spec.budget) {
    policy.budget = { amount: units(spec.budget.amount), period_ns: parseDuration(spec.budget.period) };
  }
  if (spec.approvalThreshold) policy.approval_threshold = units(spec.approvalThreshold);
  if (spec.timeWindow) {
    policy.time_window = { start_h: spec.timeWindow.startH, end_h: spec.timeWindow.endH, days: spec.timeWindow.days ?? [] };
  }
  if (spec.expiresAt) policy.expires_at_ns = (BigInt(spec.expiresAt.getTime()) * 1_000_000n).toString();
  if (spec.ftStorageDeposit) policy.ft_storage_deposit = parseNear(spec.ftStorageDeposit).toString();
  if (spec.maxConsecutiveRejections !== undefined) policy.max_consecutive_rejections = spec.maxConsecutiveRejections;
  if (spec.maxOpenApprovals !== undefined) policy.max_open_approvals = spec.maxOpenApprovals;
  return policy;
}
