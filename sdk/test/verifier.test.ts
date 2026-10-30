import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestHash } from '../src/hash.ts';
import { ReceiptVerifier } from '../src/verifier.ts';
import { FakeRpc } from './helpers/fake-rpc.ts';

let rpc: FakeRpc;
beforeEach(() => {
  rpc = new FakeRpc();
  rpc.install();
});
afterEach(() => vi.unstubAllGlobals());

const claim = { vaultId: 'vault.test', receiptId: 4, payee: 'api.test', minAmount: 20n, nonce: 'n1' };
const receipt = (overrides: Record<string, unknown> = {}) => ({ id: 4, kind: 'pay', status: { status: 'paid' }, payee: 'api.test', amount: '20', ...overrides });

describe('ReceiptVerifier (payee side)', () => {
  it('accepts a receipt of a trusted vault with one verify_receipt view at final finality', async () => {
    rpc.view('verify_receipt', () => true);
    const v = new ReceiptVerifier({ rpcUrl: rpc.url, trustedVaults: ['vault.test'] });
    expect(await v.verify(claim)).toEqual({ ok: true, blockHash: rpc.blockHash });
    expect(rpc.viewCalls[0]).toMatchObject({
      method: 'verify_receipt',
      args: { receipt_id: 4, payee: 'api.test', min_amount: '20', request_hash: requestHash('n1') },
      finality: 'final',
    });
  });

  it('refuses vaults it does not trust without asking the chain', async () => {
    const v = new ReceiptVerifier({ rpcUrl: rpc.url, trustedVaults: ['other.test'] });
    expect(await v.verify(claim)).toMatchObject({ ok: false, reason: 'untrusted_vault' });
    expect(rpc.calls).toEqual([]);
  });

  it('accepts any vault running a trusted code hash, checked at the same block', async () => {
    rpc.view('verify_receipt', () => true);
    rpc.codeHash = 'GoodHash111111111111111111111111';
    const ok = new ReceiptVerifier({ rpcUrl: rpc.url, trustedCodeHashes: ['GoodHash111111111111111111111111'] });
    expect((await ok.verify(claim)).ok).toBe(true);
    const bad = new ReceiptVerifier({ rpcUrl: rpc.url, trustedCodeHashes: ['SomethingElse'] });
    expect(await bad.verify(claim)).toMatchObject({ ok: false, reason: 'untrusted_code' });
  });

  it('explains a refusal (wrong payee, amount, request hash)', async () => {
    rpc.view('verify_receipt', () => false);
    const v = new ReceiptVerifier({ rpcUrl: rpc.url, trustedVaults: ['vault.test'] });
    rpc.view('get_receipt', () => receipt({ payee: 'evil.test' }));
    expect(await v.verify(claim)).toMatchObject({ ok: false, reason: 'mismatch', detail: expect.stringContaining('evil.test') });
    rpc.view('get_receipt', () => receipt({ amount: '1' }));
    expect(await v.verify(claim)).toMatchObject({ reason: 'mismatch', detail: expect.stringContaining('price') });
    rpc.view('get_receipt', () => receipt());
    expect(await v.verify(claim)).toMatchObject({ reason: 'mismatch', detail: expect.stringContaining('request_hash') });
    rpc.view('get_receipt', () => receipt({ status: { status: 'rejected', reason: { code: 'paused' } } }));
    expect(await v.verify(claim)).toMatchObject({ reason: 'mismatch', detail: expect.stringContaining('rejected') });
  });

  it('NEP-141 prices: the asset goes to verify_receipt, and a receipt in another asset is explained', async () => {
    rpc.view('verify_receipt', () => false);
    rpc.view('get_receipt', () => receipt({ asset: 'near' }));
    const v = new ReceiptVerifier({ rpcUrl: rpc.url, trustedVaults: ['vault.test'] });
    const res = await v.verify({ ...claim, asset: { ft: 'usd.test' } });
    expect(rpc.viewCalls[0]?.args).toMatchObject({ asset: { ft: 'usd.test' } });
    expect(res).toMatchObject({ ok: false, reason: 'mismatch', detail: expect.stringContaining('pays in near, the price is in ft:usd.test') });
  });

  it('waits for a pending receipt to settle, then gives up', async () => {
    let paid = false;
    rpc.view('verify_receipt', () => paid);
    rpc.view('get_receipt', () => receipt({ status: { status: 'pending' } }));
    const v = new ReceiptVerifier({ rpcUrl: rpc.url, trustedVaults: ['vault.test'], waitMs: 200, intervalMs: 10 });
    setTimeout(() => (paid = true), 30);
    expect((await v.verify(claim)).ok).toBe(true);
    paid = false;
    expect(await v.verify(claim)).toMatchObject({ ok: false, reason: 'not_paid' });
  });
});
