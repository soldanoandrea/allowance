import { describe, expect, it } from 'vitest';

import { formatAmount, parseAsset, parseAssetAmount, setTokenDisplay } from '../src/asset.ts';
import { describePolicy, describeReceipt, describeRejection, describeStatus, duration, shortKey } from '../src/describe.ts';
import { buildPolicy, parseDuration } from '../src/policy.ts';
import type { Rejection } from '../src/types.ts';
import { formatUnits, parseNear, parseUnits } from '../src/units.ts';

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
    const texts = all.map((r) => describeRejection(r));
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
      'auto-disabled after 5 rejections in a row or 3 open approvals',
    ]);
    const strict = buildPolicy({ perTxCap: '1', maxConsecutiveRejections: 2, maxOpenApprovals: 1 });
    expect(strict).toMatchObject({ max_consecutive_rejections: 2, max_open_approvals: 1 });
    expect(describePolicy(strict).at(-1)).toBe('auto-disabled after 2 rejections in a row or 1 open approval');
    expect(describeRejection({ code: 'too_many_open_approvals', open: 3, max: 3 })).toBe(
      '3 approval requests already open (the policy allows 3)',
    );
  });

  it('builds and describes NEP-141 policies in token units', () => {
    setTokenDisplay('usd.test', { symbol: 'SUSD', decimals: 6 });
    const policy = buildPolicy({
      asset: { ft: 'usd.test', decimals: 6 },
      perTxCap: '10',
      budget: { amount: '20', period: '1d' },
      allow: ['api.test'],
      approvalThreshold: '5',
      ftStorageDeposit: '0.01',
    });
    expect(policy).toMatchObject({
      asset: { ft: 'usd.test' },
      per_tx_cap: '10000000',
      budget: { amount: '20000000' },
      approval_threshold: '5000000',
      ft_storage_deposit: parseNear('0.01').toString(),
    });
    expect(describePolicy(policy)).toEqual([
      'pays in ft:usd.test',
      'per-payment cap 10 SUSD',
      'budget 20 SUSD per 1d',
      'payees: api.test',
      'human approval above 5 SUSD',
      'may pay up to 0.01 NEAR to register a payee on the token',
      'auto-disabled after 5 rejections in a row or 3 open approvals',
    ]);
    expect(describeRejection({ code: 'over_per_tx_cap', cap: '10000000' }, { ft: 'usd.test' })).toBe('amount is above the per-payment cap of 10 SUSD');
    expect(describeRejection({ code: 'asset_not_allowed', allowed: { ft: 'usd.test' } })).toContain('ft:usd.test');
    expect(describeStatus({ status: 'failed', reason: 'payee_not_registered' })).toBe('failed (payee_not_registered)');
  });

  it('formats and parses amounts per asset', () => {
    setTokenDisplay('usd.test', { symbol: 'SUSD', decimals: 6 });
    expect(formatAmount('2500000', { ft: 'usd.test' })).toBe('2.5 SUSD');
    expect(formatAmount('2500000', { ft: 'unknown.test' })).toBe('2500000 unknown.test units');
    expect(formatAmount(parseNear('0.02'))).toBe('0.02 NEAR');
    expect(parseAssetAmount('1.5', { ft: 'usd.test' })).toBe(1_500_000n);
    expect(parseAssetAmount('1.5 SUSD', { ft: 'usd.test' })).toBe(1_500_000n);
    expect(parseAssetAmount('42units', { ft: 'unknown.test' })).toBe(42n);
    expect(() => parseAssetAmount('1.5', { ft: 'unknown.test' })).toThrow(/decimals/);
    expect(parseAssetAmount('0.02')).toBe(parseNear('0.02'));
    expect(parseAsset('ft:usd.test')).toEqual({ ft: 'usd.test' });
    expect(parseAsset('near')).toBe('near');
    expect(() => parseAsset('ft:Not Valid')).toThrow(/asset/);
    expect(parseUnits('0.000001', 6)).toBe(1n);
    expect(formatUnits(1n, 6)).toBe('0.000001');
  });

  it('allowlists other vaults as deposit payees and describes income splits', () => {
    const policy = buildPolicy({ perTxCap: '1', allow: ['api.test'], allowVaults: ['shop.test'] });
    expect(policy.allow).toEqual({ list: [{ account_id: 'api.test' }, { account_id: 'shop.test', methods: ['deposit'] }] });
    expect(describePolicy(policy)[1]).toBe('payees: api.test, shop.test (vault, via deposit)');
    const income = {
      id: 4, kind: 'income' as const, status: { status: 'paid' as const }, agent: { account: 'vault.test' }, payee: 'shop.test',
      amount: parseNear('1').toString(), asset: 'near' as const, memo: '', request_hash: null, ts_ns: '0', policy_version: 0,
      delivered: null, pending_id: null, approved_by: null, storage_deposit: null,
      split: [
        { account_id: 'carol.test', bps: 1000, amount: parseNear('0.1').toString(), status: 'paid' as const },
        { account_id: 'dave.test', bps: 500, amount: parseNear('0.05').toString(), status: 'failed' as const },
      ],
    };
    expect(describeReceipt(income)).toBe('#4 income 1 NEAR -> shop.test [paid]; split: carol.test 0.1 NEAR (paid), dave.test 0.05 NEAR (failed)');
  });

  it('formats durations, keys and receipts', () => {
    expect(duration('90061000000000')).toBe('1d1h1m1s');
    expect(duration('0')).toBe('0s');
    expect(shortKey('ed25519:9uk3f895LsBuhPCgWF5pNHfMvfMtE3BVcLioD31UaamR')).toBe('ed25519:9uk3f8...UaamR');
    expect(
      describeReceipt({
        id: 3, kind: 'pay', status: { status: 'paid' }, agent: { key: 'ed25519:x' }, payee: 'api.test', amount: '800000000000000000000000',
        asset: 'near', memo: 'archive', request_hash: null, ts_ns: '0', policy_version: 1, delivered: true, pending_id: 0, approved_by: 'owner.test',
        storage_deposit: null,
        split: [],
      }),
    ).toBe('#3 pay 0.8 NEAR -> api.test [paid, delivered: pass] "archive"');
  });
});
