import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CounterpartyRisk, riskNote, riskPrecheck, type RiskOptions } from '../src/index.ts';
import { MockChain, receipt } from './mock-chain.ts';

const RPC = 'http://rpc.test';
let chain: MockChain;

beforeEach(() => {
  chain = new MockChain();
  // 100k blocks of 10 s: the chain is ~11.6 days old.
  chain.accounts.set('old.test', { createdAt: 10 });
  chain.accounts.set('young.test', { createdAt: 99_000 }); // ~2.8 h
  chain.accounts.set('api.test', { createdAt: 5, code: [[5, 'CodeV1'], [99_990, 'CodeV2']] });
  chain.accounts.set('dapp.test', { createdAt: 7, code: [[7, 'StableCode']] });
  chain.accounts.set('vault.test', { createdAt: 1 });
  vi.stubGlobal('fetch', chain.fetch);
});
afterEach(() => vi.unstubAllGlobals());

const risk = (options: Partial<RiskOptions> = {}): CounterpartyRisk => new CounterpartyRisk({ rpcUrl: RPC, cacheMs: 0, ...options });
const codes = (r: { signals: Array<{ code: string }> }): string[] => r.signals.map((s) => s.code);

describe('counterparty risk: account age', () => {
  it('dates an old account exactly by binary search over view_account (archival RPC) -> allow', async () => {
    const r = await risk().assess('old.test');
    expect(r.verdict).toBe('allow');
    expect(r.account).toMatchObject({ exists: true, firstSeenHeight: 10, ageSource: 'archival_rpc', olderThanHistory: false, hasCode: false });
    expect(r.account.ageDays).toBeCloseTo((100_000 - 10) * 10 / 86_400, 3);
    expect(codes(r)).toEqual(['account_age']);
    // log2(100k) ~ 17 probes, not a scan.
    expect(chain.log.filter((m) => m === 'view_account').length).toBeLessThan(25);
  });

  it('warns on a young account, blocks below the hard minimum', async () => {
    const warn = await risk().assess('young.test');
    expect(warn.verdict).toBe('warn');
    expect(warn.account.firstSeenHeight).toBe(99_000);
    expect(warn.reasons[0]).toMatch(/young\.test is only 2\.8 h old \(first seen at block 99000\)/);
    const block = await risk({ blockBelowAgeMinutes: 6 * 60 }).assess('young.test');
    expect(block.verdict).toBe('block');
    expect(block.signals.find((s) => s.code === 'new_account')?.level).toBe('block');
  });

  it('copes with skipped heights', async () => {
    for (let h = 99_000; h < 99_006; h++) chain.skipped.add(h);
    const r = await risk().assess('young.test');
    expect(r.account.firstSeenHeight).toBe(99_000 + 6);
  });

  it('on a node with pruned history says "at least" instead of guessing', async () => {
    chain.prunedBelow = 60_000;
    const old = await risk().assess('old.test');
    expect(old.verdict).toBe('allow');
    expect(old.account.olderThanHistory).toBe(true);
    expect(old.account.firstSeenHeight).toBe(60_000);
    expect(old.signals[0]?.detail).toMatch(/at least 4 days/);
    const young = await risk().assess('young.test');
    expect(young.account.firstSeenHeight).toBe(99_000);
  });

  it('prefers the FastNear transactions API (oldest transaction) when configured', async () => {
    chain.fastnear.set('old.test', { tx_block_height: 10, tx_block_timestamp: chain.ts(10).toString() });
    const r = await risk({ fastnearTxUrl: 'https://tx.example.test' }).assess('old.test');
    expect(r.account).toMatchObject({ ageSource: 'fastnear', firstSeenHeight: 10 });
    expect(chain.log.filter((m) => m === 'view_account')).toHaveLength(1); // only the current state
    // No row there: falls back to the archival search.
    const y = await risk({ fastnearTxUrl: 'https://tx.example.test' }).assess('young.test');
    expect(y.account).toMatchObject({ ageSource: 'archival_rpc', firstSeenHeight: 99_000 });
  });

  it('blocks a payee that does not exist', async () => {
    const r = await risk().assess('ghost.test');
    expect(r.verdict).toBe('block');
    expect(codes(r)).toEqual(['account_missing']);
    expect((await risk().assess('Not Valid')).signals[0]?.code).toBe('invalid_account');
  });
});

describe('counterparty risk: contract code', () => {
  it('warns when the payee swapped its code inside the window, and finds when', async () => {
    const r = await risk().assess('api.test');
    expect(r.verdict).toBe('warn');
    expect(r.account).toMatchObject({ hasCode: true, codeHash: 'CodeV2', codeChangedAtHeight: 99_990 });
    expect(r.reasons).toEqual([expect.stringMatching(/api\.test's contract code was changed at block 99990, 2 min ago \(within 72h\)/)]);
  });

  it('reports the first produced block with the new code when heights were skipped', async () => {
    for (let h = 99_985; h < 99_993; h++) chain.skipped.add(h);
    const r = await risk().assess('api.test');
    expect(r.account.codeChangedAtHeight).toBe(99_993);
  });

  it('a contract whose code is old is only an info signal', async () => {
    const r = await risk().assess('dapp.test');
    expect(r.verdict).toBe('allow');
    expect(codes(r)).toEqual(['account_age', 'contract_account']);
    expect(r.account.codeChangedAtHeight).toBeNull();
  });

  it('a short window ignores older changes', async () => {
    chain.accounts.set('api.test', { createdAt: 5, code: [[5, 'CodeV1'], [90_000, 'CodeV2']] }); // ~27.8 h ago
    expect((await risk({ codeWindowHours: 24 }).assess('api.test')).verdict).toBe('allow');
    expect((await risk({ codeWindowHours: 48 }).assess('api.test')).verdict).toBe('warn');
  });
});

describe('counterparty risk: deny-lists and vault history', () => {
  it('blocks local and on-chain denylisted payees', async () => {
    expect((await risk({ denylist: ['old.test'] }).assess('old.test')).signals[0]).toMatchObject({ code: 'denylisted', level: 'block' });
    chain.vaultDenylist = ['old.test'];
    const r = await risk({ vaultId: 'vault.test' }).assess('old.test');
    expect(r.verdict).toBe('block');
    expect(codes(r)).toContain('vault_denylisted');
  });

  it('summarises prior receipts to the payee and warns on failed deliveries', async () => {
    chain.receipts = [
      receipt(0, 'old.test', '20000000000000000000000', { delivered: true }),
      receipt(1, 'old.test', '2000000', { asset: { ft: 'usd.test' }, delivered: false }),
      receipt(2, 'old.test', '1', { status: { status: 'rejected', reason: { code: 'over_budget' } } }),
      receipt(3, 'other.test', '5'),
      { ...(receipt(4, 'vault.test', '5') as object), kind: 'income' },
    ];
    const r = await risk({ vaultId: 'vault.test' }).assess('old.test');
    expect(r.history).toMatchObject({ receipts: 3, paid: 2, rejected: 1, deliveredOk: 1, deliveredFailed: 1, scanned: 5 });
    expect(r.history?.totals).toEqual([
      { asset: 'near', amount: '20000000000000000000000' },
      { asset: { ft: 'usd.test' }, amount: '2000000' },
    ]);
    expect(r.verdict).toBe('warn');
    expect(codes(r)).toEqual(['account_age', 'known_payee', 'failed_deliveries']);
    expect(r.signals.find((s) => s.code === 'known_payee')?.detail).toContain('0.02 NEAR + 2000000 usd.test units');
    const first = await risk({ vaultId: 'vault.test' }).assess('dapp.test');
    expect(codes(first)).toContain('first_payment');
  });

  it('fails safe: an unreachable node is a warning, never a silent allow', async () => {
    chain.fail = true;
    const r = await risk({ vaultId: 'vault.test' }).assess('old.test');
    expect(r.verdict).toBe('warn');
    expect(codes(r).every((c) => c === 'check_error')).toBe(true);
  });

  it('caches the account facts, but reads deny-lists and receipts every time', async () => {
    const r = risk({ cacheMs: 60_000, vaultId: 'vault.test' });
    expect(codes(await r.assess('old.test'))).toContain('first_payment');
    const views = chain.log.filter((m) => m === 'view_account').length;
    chain.receipts = [receipt(0, 'old.test', '1')];
    chain.vaultDenylist = ['old.test'];
    const again = await r.assess('old.test');
    expect(chain.log.filter((m) => m === 'view_account').length).toBe(views);
    expect(codes(again)).toEqual(['vault_denylisted', 'account_age', 'known_payee']);
  });
});

describe('agent integration', () => {
  it('riskNote is a compact memo suffix; riskPrecheck feeds runPaidTask', async () => {
    const r = risk({ vaultId: 'vault.test' });
    expect(riskNote(await r.assess('young.test'))).toBe('risk=warn[new_account,first_payment]');
    expect(riskNote(await r.assess('old.test'))).toBe('risk=allow[first_payment]');
    const check = await riskPrecheck(r)('ghost.test');
    expect(check).toMatchObject({ verdict: 'block', reason: 'account ghost.test does not exist', note: 'risk=block[account_missing,first_payment]' });
  });
});
