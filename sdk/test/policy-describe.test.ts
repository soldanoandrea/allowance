import { describe, expect, it } from 'vitest';

import { describePolicy, describeReceipt, describeRejection, duration, shortKey } from '../src/describe.ts';
import { buildPolicy, parseDuration } from '../src/policy.ts';
import type { Rejection } from '../src/types.ts';

describe('policy builder', () => {
  it('builds the contract JSON from human units', () => {
    const policy = buildPolicy({
      perTxCap: '1',
      budget: { amount: '2', period: '1d' },
      allow: ['api.test'],
      approvalThreshold: '0.5',
      cooldown: '5s',
      timeWindow: { startH: 9, endH: 17, days: [1, 2, 3, 4, 5] },
    });
    expect(policy).toEqual({
      asset: 'near',
      per_tx_cap: '1000000000000000000000000',
      budget: { amount: '2000000000000000000000000', period_ns: '86400000000000' },
      allow: { list: [{ account_id: 'api.test' }] },
      approval_threshold: '500000000000000000000000',
      cooldown_ns: '5000000000',
      time_window: { start_h: 9, end_h: 17, days: [1, 2, 3, 4, 5] },
    });
    expect(buildPolicy({ perTxCap: '1' }).allow).toBe('any');
  });

  it('parses durations', () => {
    expect(parseDuration('1h')).toBe('3600000000000');
    expect(parseDuration('2w')).toBe((14n * 86_400n * 10n ** 9n).toString());
    expect(() => parseDuration('1 year')).toThrow();
  });
});

describe('descriptions', () => {
  it('explains every rejection code', () => {
    const all: Rejection[] = [
      { code: 'paused' },
      { code: 'agent_disabled' },
      { code: 'policy_expired', expired_at_ns: '0' },
      { code: 'asset_not_allowed', allowed: 'near' },
      { code: 'denylisted', payee: 'bad.test' },
      { code: 'not_allowlisted', payee: 'attacker.test' },
      { code: 'over_per_tx_cap', cap: '1000000000000000000000000' },
      { code: 'outside_time_window', opens_at_ns: '0' },
      { code: 'cooldown', retry_at_ns: '0' },
      { code: 'over_budget', remaining: '0', resets_at_ns: '0' },
      { code: 'insufficient_vault_balance', available: '0' },
      { code: 'unknown_agent' },
    ];
    const texts = all.map(describeRejection);
    expect(new Set(texts).size).toBe(all.length);
    expect(describeRejection({ code: 'not_allowlisted', payee: 'attacker.test' })).toBe('payee attacker.test is not on the allowlist');
    expect(describeRejection({ code: 'over_per_tx_cap', cap: '1000000000000000000000000' })).toBe('amount is above the per-payment cap of 1 NEAR');
  });

  it('summarises a policy in check order', () => {
    expect(describePolicy(buildPolicy({ perTxCap: '1', budget: { amount: '2', period: '1d' }, allow: ['api.test'], approvalThreshold: '0.5' }))).toEqual([
      'per-payment cap 1 NEAR',
      'budget 2 NEAR per 1d',
      'payees: api.test',
      'human approval above 0.5 NEAR',
    ]);
  });

  it('formats durations, keys and receipts', () => {
    expect(duration('90061000000000')).toBe('1d1h1m1s');
    expect(duration('0')).toBe('0s');
    expect(shortKey('ed25519:9uk3f895LsBuhPCgWF5pNHfMvfMtE3BVcLioD31UaamR')).toBe('ed25519:9uk3f8...UaamR');
    expect(
      describeReceipt({
        id: 3, kind: 'pay', status: { status: 'paid' }, agent: { key: 'ed25519:x' }, payee: 'api.test', amount: '800000000000000000000000',
        asset: 'near', memo: 'archive', request_hash: null, ts_ns: '0', policy_version: 1, delivered: true, pending_id: 0, approved_by: 'owner.test',
      }),
    ).toBe('#3 pay 0.8 NEAR -> api.test [paid, delivered: pass] "archive"');
  });
});
