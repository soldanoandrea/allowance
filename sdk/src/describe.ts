import { assetLabel, formatAmount } from './asset.ts';
import type { AgentId, Asset, Failure, Policy, Receipt, ReceiptStatus, Rejection } from './types.ts';
import { near, nsToDate } from './units.ts';

/**
 * Short, human-readable reason for a policy rejection. Amounts in a
 * rejection are in the policy's asset: pass it to format them (default NEAR).
 */
export function describeRejection(reason: Rejection, asset: Asset = 'near'): string {
  switch (reason.code) {
    case 'paused':
      return 'the vault is paused';
    case 'agent_disabled':
      return 'this agent is disabled (only the owner re-enables it)';
    case 'policy_expired':
      return `the policy expired at ${iso(reason.expired_at_ns)}`;
    case 'asset_not_allowed':
      return `this asset is not allowed by the policy (it pays in ${assetLabel(reason.allowed)})`;
    case 'denylisted':
      return `payee ${reason.payee} is on the vault denylist`;
    case 'not_allowlisted':
      return `payee ${reason.payee} is not on the allowlist`;
    case 'over_per_tx_cap':
      return `amount is above the per-payment cap of ${formatAmount(reason.cap, asset)}`;
    case 'outside_time_window':
      return `outside the allowed time window (opens ${iso(reason.opens_at_ns)})`;
    case 'cooldown':
      return `cooldown: retry after ${iso(reason.retry_at_ns)}`;
    case 'over_budget':
      return `over budget: ${formatAmount(reason.remaining, asset)} left until ${iso(reason.resets_at_ns)}`;
    case 'insufficient_vault_balance':
      return `the vault only has ${formatAmount(reason.available, asset)} available`;
    case 'unknown_agent':
      return 'this key is not a registered agent of the vault';
    case 'too_many_open_approvals':
      return `${reason.open} approval requests already open (the policy allows ${reason.max})`;
  }
}

export function describeFailure(reason: Failure): string {
  switch (reason) {
    case 'transfer_failed':
      return 'the NEAR transfer failed (does the payee account exist?)';
    case 'ft_transfer_failed':
      return 'ft_transfer failed on the token contract';
    case 'payee_not_registered':
      return 'the payee has no storage on the token and the policy does not pay for it';
    case 'insufficient_near_for_storage':
      return 'not enough NEAR in the vault to register the payee on the token';
    case 'storage_check_failed':
      return 'the token did not answer storage_balance_of (NEP-145)';
  }
}

export function describeStatus(status: ReceiptStatus): string {
  if (status.status === 'rejected') return `rejected (${status.reason.code})`;
  if (status.status === 'failed') return `failed (${status.reason})`;
  return status.status;
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
  const asset = policy.asset ?? 'near';
  const fmt = (v: string): string => formatAmount(v, asset);
  const lines = asset === 'near' ? [] : [`pays in ${assetLabel(asset)}`];
  lines.push(`per-payment cap ${fmt(policy.per_tx_cap)}`);
  if (policy.budget) {
    lines.push(`budget ${fmt(policy.budget.amount)} per ${duration(policy.budget.period_ns)}`);
  }
  const allow = policy.allow ?? 'any';
  lines.push(
    allow === 'any'
      ? 'any payee (denylist applies)'
      : `payees: ${allow.list.map((e) => (e.methods?.includes('deposit') ? `${e.account_id} (vault, via deposit)` : e.account_id)).join(', ')}`,
  );
  if (policy.approval_threshold) lines.push(`human approval above ${fmt(policy.approval_threshold)}`);
  if (policy.cooldown_ns && policy.cooldown_ns !== '0') lines.push(`cooldown ${duration(policy.cooldown_ns)}`);
  if (policy.time_window) {
    const days = policy.time_window.days?.length ? ` on ISO days ${policy.time_window.days.join(',')}` : '';
    lines.push(`UTC ${policy.time_window.start_h}:00-${policy.time_window.end_h}:00${days}`);
  }
  if (policy.expires_at_ns) lines.push(`expires ${iso(policy.expires_at_ns)}`);
  if (policy.ft_storage_deposit) lines.push(`may pay up to ${near(policy.ft_storage_deposit)} to register a payee on the token`);
  const open = policy.max_open_approvals ?? 3;
  lines.push(`auto-disabled after ${policy.max_consecutive_rejections ?? 5} rejections in a row or ${open} open approval${open === 1 ? '' : 's'}`);
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
  const split = r.split?.length ? `; split: ${describeSplit(r)}` : '';
  return `#${r.id} ${r.kind} ${formatAmount(r.amount, r.asset)} -> ${r.payee} [${describeStatus(r.status)}${delivered}]${memo}${split}`;
}

/** "carol.near 0.1 NEAR (paid), dave.near 0.05 NEAR (failed)". */
export function describeSplit(r: Pick<Receipt, 'split' | 'asset'>): string {
  return (r.split ?? []).map((p) => `${p.account_id} ${formatAmount(p.amount, r.asset)} (${p.status})`).join(', ');
}
