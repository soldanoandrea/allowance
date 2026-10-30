import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../src/sandbox.ts';

const EMPTY = '11111111111111111111111111111111';

/** Load ledger/core.js (a classic browser script) in a VM with a fake fetch. */
function loadLedger(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const fetch = async (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body) as { id: string; method: string; params: Record<string, unknown> };
    calls.push(req);
    try {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: handler(req.method, req.params) }));
    } catch (e) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { name: 'HANDLER_ERROR', cause: { name: (e as Error).message } } }), { status: 422 });
    }
  };
  const ctx: Record<string, unknown> = { fetch, TextEncoder, TextDecoder, btoa, atob };
  runInNewContext(readFileSync(join(REPO_ROOT, 'ledger', 'core.js'), 'utf8'), ctx);
  return { L: ctx['AllowanceLedger'] as Record<string, (...args: never[]) => unknown> & LedgerApi, calls };
}

interface LedgerApi {
  loadSnapshot(url: string, vault: string): Promise<{ vault: { next_receipt_id: number }; receipts: Array<{ id: number }>; agents: unknown[] }>;
  scanEvents(url: string, vault: string, state: ScanState, opts?: Record<string, unknown>): Promise<ScanState>;
  formatNear(yocto: string): string;
  describePolicy(policy: unknown): string[];
  describeEvent(ev: unknown): string;
}
interface ScanState {
  nextHeight: number;
  events: Array<{ height: number; event: string; data: Record<string, unknown> }>;
  seenTx: Record<string, boolean>;
  unavailable?: number;
  head?: number;
}

function viewResult(value: unknown) {
  return { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1, block_hash: 'h' };
}

describe('ledger page data layer (ledger/core.js)', () => {
  it('loads the vault snapshot and pages receipts', async () => {
    const { L, calls } = loadLedger((method, params) => {
      expect(method).toBe('query');
      const name = params['method_name'];
      const args = JSON.parse(Buffer.from(String(params['args_base64']), 'base64').toString()) as Record<string, number>;
      if (name === 'get_vault') return viewResult({ first_receipt_id: 0, next_receipt_id: 120 });
      if (name === 'get_receipts') {
        const from = args['from_id'] ?? 0;
        return viewResult(Array.from({ length: Math.min(50, 120 - from) }, (_, i) => ({ id: from + i })));
      }
      return viewResult([]);
    });
    const snap = await L.loadSnapshot('http://rpc', 'vault.test');
    expect(snap.receipts.map((r) => r.id)).toEqual(Array.from({ length: 120 }, (_, i) => i));
    expect(calls.every((c) => c.params['account_id'] === 'vault.test' && c.params['finality'] === 'optimistic')).toBe(true);
  });

  it('finds events of transactions sent to the vault only, skipping empty chunks and missing blocks', async () => {
    const log = (event: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: 'allowance', version: '1.0.0', event, data })}`;
    const { L } = loadLedger((method, params) => {
      if (method === 'block' && params['finality']) return { header: { height: 5 } };
      if (method === 'block') {
        const h = Number(params['block_id']);
        if (h === 3) throw new Error('UNKNOWN_BLOCK');
        return { header: { height: h }, chunks: [{ chunk_hash: `c${h}`, tx_root: h === 2 || h === 4 ? 'root' : EMPTY, height_included: h }] };
      }
      if (method === 'chunk') {
        return params['chunk_id'] === 'c2'
          ? { transactions: [{ hash: 't1', signer_id: 'vault.test', receiver_id: 'vault.test' }, { hash: 'x', signer_id: 'a', receiver_id: 'other.test' }] }
          : { transactions: [{ hash: 't2', signer_id: 'owner.test', receiver_id: 'vault.test' }] };
      }
      if (method === 'tx') {
        return params['tx_hash'] === 't1'
          ? { transaction_outcome: { outcome: { logs: [] } }, receipts_outcome: [{ outcome: { logs: [log('payment_paid', { receipt_id: 1, amount: '20000000000000000000000', payee: 'api.test' })] } }] }
          : { transaction_outcome: { outcome: { logs: [] } }, receipts_outcome: [{ outcome: { logs: ['not an event', log('approval_granted', { pending_id: 0, approver: 'owner.test' })] } }] };
      }
      throw new Error(`unexpected ${method}`);
    });
    const state: ScanState = { nextHeight: 1, events: [], seenTx: {} };
    await L.scanEvents('http://rpc', 'vault.test', state);
    expect(state.events.map((e) => [e.height, e.event])).toEqual([[2, 'payment_paid'], [4, 'approval_granted']]);
    expect(state.unavailable).toBe(1);
    expect(state.nextHeight).toBe(6);
    expect(L.describeEvent(state.events[0])).toBe('#1 0.02 NEAR -> api.test');
    await L.scanEvents('http://rpc', 'vault.test', state);
    expect(state.events).toHaveLength(2);
  });

  it('formats amounts and policies like the CLI', () => {
    const { L } = loadLedger(() => null);
    expect(L.formatNear('20000000000000000000000')).toBe('0.02 NEAR');
    expect(L.formatNear('1')).toBe('<0.0001 NEAR');
    expect(L.describePolicy({ per_tx_cap: '1000000000000000000000000', budget: { amount: '2000000000000000000000000', period_ns: '86400000000000' }, allow: { list: [{ account_id: 'api.test' }] }, approval_threshold: '500000000000000000000000', cooldown_ns: '0' })).toEqual([
      'cap 1 NEAR per payment',
      'budget 2 NEAR per 1d',
      'payees: api.test',
      'human approval above 0.5 NEAR',
    ]);
  });
});
