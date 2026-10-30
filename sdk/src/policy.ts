import type { Policy } from './types.ts';
import { parseNear } from './units.ts';

const NS_PER_SEC = 1_000_000_000n;
const UNITS: Record<string, bigint> = { s: 1n, m: 60n, h: 3_600n, d: 86_400n, w: 604_800n };

/** "30s", "5m", "1h", "1d", "1w" -> nanoseconds (decimal string, the contract's U64). */
export function parseDuration(text: string): string {
  const match = /^(\d+)\s*([smhdw])$/.exec(text.trim());
  if (!match) throw new Error(`invalid duration ${JSON.stringify(text)} (expected e.g. "1d", "30s")`);
  return (BigInt(match[1] ?? '0') * (UNITS[match[2] ?? 's'] ?? 1n) * NS_PER_SEC).toString();
}

export interface PolicySpec {
  /** Hard ceiling for one payment, in NEAR ("1"). */
  perTxCap: string;
  /** Budget per window, e.g. { amount: "2", period: "1d" }. */
  budget?: { amount: string; period: string };
  /** Allowlisted payees; omit for "any" (the vault denylist still applies). */
  allow?: string[];
  /** Above this amount (NEAR) a human approves. Must be below perTxCap. */
  approvalThreshold?: string;
  /** Minimum time between payments ("10s"). */
  cooldown?: string;
  timeWindow?: { startH: number; endH: number; days?: number[] };
  /** Expiry as a Date. */
  expiresAt?: Date;
}

/** Build the contract's `Policy` JSON from human units. */
export function buildPolicy(spec: PolicySpec): Policy {
  const policy: Policy = {
    asset: 'near',
    per_tx_cap: parseNear(spec.perTxCap).toString(),
    allow: spec.allow ? { list: spec.allow.map((account_id) => ({ account_id })) } : 'any',
    cooldown_ns: spec.cooldown ? parseDuration(spec.cooldown) : '0',
  };
  if (spec.budget) {
    policy.budget = { amount: parseNear(spec.budget.amount).toString(), period_ns: parseDuration(spec.budget.period) };
  }
  if (spec.approvalThreshold) policy.approval_threshold = parseNear(spec.approvalThreshold).toString();
  if (spec.timeWindow) {
    policy.time_window = { start_h: spec.timeWindow.startH, end_h: spec.timeWindow.endH, days: spec.timeWindow.days ?? [] };
  }
  if (spec.expiresAt) policy.expires_at_ns = (BigInt(spec.expiresAt.getTime()) * 1_000_000n).toString();
  return policy;
}
