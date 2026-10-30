import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultCatalog } from '../../demo-api/src/catalog.ts';
import { createApiServer, type ApiServer } from '../../demo-api/src/server.ts';
import { runPaidTask } from '../src/agent/paid-task.ts';
import { ScriptedPlanner } from '../src/agent/planner.ts';
import { AllowanceClient } from '../src/client.ts';
import { parseNear } from '../src/units.ts';
import { FakeVault, fakeVerifier } from './helpers/fake-vault.ts';

let vault: FakeVault;
let api: ApiServer;
let url: string;
let lines: string[];
let verifier: ReturnType<typeof fakeVerifier>;

beforeEach(async () => {
  vault = new FakeVault();
  verifier = fakeVerifier(vault);
  api = createApiServer({ payee: 'api.test', verifier, attacker: 'attacker.test' });
  url = await api.listen();
  lines = [];
});
afterEach(() => api.close());

function deps() {
  return {
    client: new AllowanceClient({ vaultId: vault.vaultId, transport: vault }),
    planner: new ScriptedPlanner(),
    log: (l: string) => lines.push(l),
    approvalPollMs: 1,
  };
}

const rowsCheck = (n: number) => (d: unknown) => ((d as { data: { rows: unknown[] } }).data.rows.length === n);

describe('agent task loop against the demo API (in-memory vault)', () => {
  it('402 -> simulate allow -> pay -> retry with the receipt -> 200 -> confirm_delivery(true)', async () => {
    const res = await runPaidTask({ name: 'candles', url: `${url}/dataset`, check: rowsCheck(30) }, deps());
    expect(res).toMatchObject({ status: 'delivered', receiptId: 0, paidAmount: parseNear('0.02'), passed: true, counteroffer: null, approved: false });
    expect(vault.receipts[0]).toMatchObject({ payee: 'api.test', amount: parseNear('0.02').toString(), delivered: true });
    expect(verifier.claims[0]).toMatchObject({ vaultId: 'vault.test', receiptId: 0, payee: 'api.test', minAmount: parseNear('0.02') });
    expect(vault.calls.map((c) => c.method)).toEqual(['get_agent', 'simulate', 'pay', 'confirm_delivery']);
  });

  it('needs_approval -> one counteroffer accepted by the seller -> paid autonomously at the lower price', async () => {
    const res = await runPaidTask({ name: 'depth', url: `${url}/dataset/premium` }, deps());
    expect(res).toMatchObject({ status: 'delivered', paidAmount: parseNear('0.5'), approved: false, counteroffer: { status: 'accepted' } });
    expect(lines.some((l) => l.includes('x-allowance-offer: 500000000000000000000000'))).toBe(true);
  });

  it('counteroffer rejected -> pays the list price -> waits for the owner -> approved -> delivered', async () => {
    const res = await runPaidTask({ name: 'archive', url: `${url}/dataset/archive` }, deps());
    expect(res).toMatchObject({ status: 'delivered', paidAmount: parseNear('0.8'), approved: true, counteroffer: { status: 'rejected' } });
    expect(vault.receipts[0]).toMatchObject({ approved_by: 'owner.test', delivered: true });
    expect(lines.some((l) => l.startsWith('waiting for the owner'))).toBe(true);
  });

  it('owner never approves -> the agent gives up without the data', async () => {
    vault.approveAfterPolls = null;
    const d = { ...deps(), approvalTimeoutMs: 20 };
    await expect(runPaidTask({ name: 'archive', url: `${url}/dataset/archive` }, d)).rejects.toThrow(/still pending/);
  });

  it('block -> refuses without signing', async () => {
    vault.allow = [];
    const res = await runPaidTask({ name: 'candles', url: `${url}/dataset` }, deps());
    expect(res).toEqual({ status: 'refused', reason: 'payee api.test is not on the allowlist', receiptId: null });
    expect(vault.calls.some((c) => c.method === 'pay')).toBe(false);
  });

  it('records a failed acceptance check on-chain', async () => {
    const res = await runPaidTask({ name: 'candles', url: `${url}/dataset`, check: rowsCheck(31) }, deps());
    expect(res).toMatchObject({ status: 'delivered', passed: false });
    expect(vault.receipts[0]?.delivered).toBe(false);
  });

  it('pays a resource priced in a NEP-141 token in that token', async () => {
    const ftApi = createApiServer({ payee: 'api.test', verifier, catalog: defaultCatalog({ ftToken: 'usd.test' }) });
    const ftUrl = await ftApi.listen();
    try {
      const res = await runPaidTask({ name: 'fx', url: `${ftUrl}/dataset/fx` }, deps());
      expect(res).toMatchObject({ status: 'delivered', paidAmount: 2_000_000n, asset: { ft: 'usd.test' }, passed: true });
      expect(vault.calls.find((c) => c.method === 'simulate')?.args).toMatchObject({ asset: { ft: 'usd.test' }, amount: '2000000' });
      expect(vault.calls.find((c) => c.method === 'pay')?.args).toMatchObject({ asset: { ft: 'usd.test' }, amount: '2000000' });
      expect(verifier.claims[0]).toMatchObject({ asset: { ft: 'usd.test' }, minAmount: 2_000_000n });
    } finally {
      await ftApi.close();
    }
  });

  it('a counterparty pre-check runs before simulate: block refuses, warn is written into the memo', async () => {
    const blocked = await runPaidTask(
      { name: 'candles', url: `${url}/dataset` },
      { ...deps(), precheck: async () => ({ verdict: 'block', reason: 'api.test is on the deny-list', note: 'risk=block[denylisted]' }) },
    );
    expect(blocked).toEqual({ status: 'refused', reason: 'counterparty check: api.test is on the deny-list', receiptId: null });
    expect(vault.calls.some((c) => c.method === 'simulate' || c.method === 'pay')).toBe(false);

    const warned = await runPaidTask(
      { name: 'candles', url: `${url}/dataset` },
      { ...deps(), precheck: async () => ({ verdict: 'warn', reason: 'young account', note: 'risk=warn[new_account]' }) },
    );
    expect(warned.status).toBe('delivered');
    expect(vault.receipts[0]?.memo).toBe('candles | /dataset | risk=warn[new_account]');
    expect(lines).toContain('counterparty check api.test: WARN (young account)');
  });

  it('free resources need no payment', async () => {
    const res = await runPaidTask({ name: 'news', url: `${url}/web/market-news` }, deps());
    expect(res).toMatchObject({ status: 'delivered', receiptId: null, paidAmount: 0n });
  });
});
