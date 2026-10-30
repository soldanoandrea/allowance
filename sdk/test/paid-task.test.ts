import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    expect(res).toMatchObject({ status: 'delivered', receiptId: 0, paidYocto: parseNear('0.02'), passed: true, counteroffer: null, approved: false });
    expect(vault.receipts[0]).toMatchObject({ payee: 'api.test', amount: parseNear('0.02').toString(), delivered: true });
    expect(verifier.claims[0]).toMatchObject({ vaultId: 'vault.test', receiptId: 0, payee: 'api.test', minAmount: parseNear('0.02') });
    expect(vault.calls.map((c) => c.method)).toEqual(['get_agent', 'simulate', 'pay', 'confirm_delivery']);
  });

  it('needs_approval -> one counteroffer accepted by the seller -> paid autonomously at the lower price', async () => {
    const res = await runPaidTask({ name: 'depth', url: `${url}/dataset/premium` }, deps());
    expect(res).toMatchObject({ status: 'delivered', paidYocto: parseNear('0.5'), approved: false, counteroffer: { status: 'accepted' } });
    expect(lines.some((l) => l.includes('x-allowance-offer: 500000000000000000000000'))).toBe(true);
  });

  it('counteroffer rejected -> pays the list price -> waits for the owner -> approved -> delivered', async () => {
    const res = await runPaidTask({ name: 'archive', url: `${url}/dataset/archive` }, deps());
    expect(res).toMatchObject({ status: 'delivered', paidYocto: parseNear('0.8'), approved: true, counteroffer: { status: 'rejected' } });
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

  it('free resources need no payment', async () => {
    const res = await runPaidTask({ name: 'news', url: `${url}/web/market-news` }, deps());
    expect(res).toMatchObject({ status: 'delivered', receiptId: null, paidYocto: 0n });
  });
});
