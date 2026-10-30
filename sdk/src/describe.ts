import type { AgentId, Policy, Receipt, ReceiptStatus, Rejection } from './types.ts';
import { near, nsToDate } from './units.ts';

/** Short, human-readable reason for a policy rejection. */
export function describeRejection(reason: Rejection): string {
  switch (reason.code) {
    case 'paused':
      return 'the vault is paused';
    case 'agent_disabled':
      return 'this agent is disabled by the owner';
    case 'policy_expired':
      return `the policy expired at ${iso(reason.expired_at_ns)}`;
    case 'asset_not_allowed':
      return 'this asset is not allowed by the policy';
    case 'denylisted':
      return `payee ${reason.payee} is on the vault denylist`;
    case 'not_allowlisted':
      return `payee ${reason.payee} is not on the allowlist`;
    case 'over_per_tx_cap':
      return `amount is above the per-payment cap of ${near(reason.cap)}`;
    case 'outside_time_window':
      return `outside the allowed time window (opens ${iso(reason.opens_at_ns)})`;
    case 'cooldown':
      return `cooldown: retry after ${iso(reason.retry_at_ns)}`;
    case 'over_budget':
      return `over budget: ${near(reason.remaining)} left until ${iso(reason.resets_at_ns)}`;
    case 'insufficient_vault_balance':
      return `the vault only has ${near(reason.available)} available`;
    case 'unknown_agent':
      return 'this key is not a registered agent of the vault';
  }
}

export function describeStatus(status: ReceiptStatus): string {
  return status.status === 'rejected' ? `rejected (${status.reason.code})` : status.status;
}

export function describeAgent(agent: AgentId): string {
  return 'key' in agent ? shortKey(agent.key) : agent.account;
}

/** `ed25519:9uk3f8...UaamR` */
export function shortKey(key: string): string {
  const [curve, body] = key.includes(':') ? key.split(':', 2) : ['', key];
  if (!body || body.length <= 12) return key;
  return `${curve ? `${curve}:` : ''}${body.slice(0, 6)}...${body.slice(-5)}`;
}

/** One line per rule, in the order the contract checks them. */
export function describePolicy(policy: Policy): string[] {
  const lines = [`per-payment cap ${near(policy.per_tx_cap)}`];
  if (policy.budget) {
    lines.push(`budget ${near(policy.budget.amount)} per ${duration(policy.budget.period_ns)}`);
  }
  const allow = policy.allow ?? 'any';
  lines.push(allow === 'any' ? 'any payee (denylist applies)' : `payees: ${allow.list.map((e) => e.account_id).join(', ')}`);
  if (policy.approval_threshold) lines.push(`human approval above ${near(policy.approval_threshold)}`);
  if (policy.cooldown_ns && policy.cooldown_ns !== '0') lines.push(`cooldown ${duration(policy.cooldown_ns)}`);
  if (policy.time_window) {
    const days = policy.time_window.days?.length ? ` on ISO days ${policy.time_window.days.join(',')}` : '';
    lines.push(`UTC ${policy.time_window.start_h}:00-${policy.time_window.end_h}:00${days}`);
  }
  if (policy.expires_at_ns) lines.push(`expires ${iso(policy.expires_at_ns)}`);
  return lines;
}

/** "86400000000000" -> "1d", "5000000000" -> "5s". */
export function duration(ns: string): string {
  let seconds = Number(BigInt(ns) / 1_000_000_000n);
  const parts: string[] = [];
  for (const [unit, size] of [['d', 86_400], ['h', 3_600], ['m', 60]] as const) {
    if (seconds >= size) {
      parts.push(`${Math.floor(seconds / size)}${unit}`);
      seconds %= size;
    }
  }
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join('');
}

export function iso(ns: string): string {
  return nsToDate(ns).toISOString().replace('.000Z', 'Z');
}

/** One-line receipt summary for logs. */
export function describeReceipt(r: Receipt): string {
  const delivered = r.delivered === null ? '' : r.delivered ? ', delivered: pass' : ', delivered: FAIL';
  const memo = r.memo ? ` "${r.memo}"` : '';
  return `#${r.id} ${r.kind} ${near(r.amount)} -> ${r.payee} [${describeStatus(r.status)}${delivered}]${memo}`;
}
