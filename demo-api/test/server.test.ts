import { HEADERS, parseNear, parsePaymentRequired, requestHash, type PaymentRequired, type ReceiptClaim, type VerifyResult } from '@allowance/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultCatalog } from '../src/catalog.ts';
import { createApiServer, type ApiServer } from '../src/server.ts';

let api: ApiServer;
let url: string;
let claims: ReceiptClaim[];
let answer: (claim: ReceiptClaim) => VerifyResult;

beforeEach(async () => {
  claims = [];
  answer = () => ({ ok: true, blockHash: 'b' });
  api = createApiServer({
    payee: 'api.test',
    attacker: 'attacker.test',
    defaultVault: 'vault.test',
    verifier: {
      accepts: { vaults: ['vault.test'], code_hashes: [] },
      verify: async (claim) => {
        claims.push(claim);
        return answer(claim);
      },
    },
  });
  url = await api.listen();
});
afterEach(() => api.close());

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}${path}`, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

async function quote(path = '/dataset'): Promise<PaymentRequired> {
  const res = await get(path);
  expect(res.status).toBe(402);
  return parsePaymentRequired(res.body);
}

describe('demo API: HTTP 402 flow', () => {
  it('answers 402 with a valid quote: payee, price, nonce and sha256(nonce)', async () => {
    const q = await quote();
    expect(q).toMatchObject({ payee: 'api.test', asset: 'near', amount: parseNear('0.02').toString(), resource: '/dataset' });
    expect(q.request_hash_base64).toBe(requestHash(q.nonce));
    expect(q.accepts.vaults).toEqual(['vault.test']);
    expect(q.instructions).toContain(HEADERS.receipt);
    expect((await quote()).nonce).not.toBe(q.nonce);
  });

  it('serves the data once the receipt verifies, and only once', async () => {
    const q = await quote();
    const headers = { [HEADERS.receipt]: 'vault.test:7', [HEADERS.nonce]: q.nonce };
    const ok = await get('/dataset', headers);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-allowance-paid')).toBe('vault.test:7');
    expect((ok.body['data'] as { rows: unknown[] }).rows).toHaveLength(30);
    expect(claims[0]).toEqual({ vaultId: 'vault.test', receiptId: 7, payee: 'api.test', minAmount: parseNear('0.02'), asset: 'near', nonce: q.nonce });
    const replay = await get('/dataset', headers);
    expect(replay.status).toBe(402);
    expect(replay.body['error']).toBe('unknown_nonce');
  });

  it('a redeemed receipt cannot be reused with a fresh nonce', async () => {
    const first = await quote();
    expect((await get('/dataset', { [HEADERS.receipt]: 'vault.test:7', [HEADERS.nonce]: first.nonce })).status).toBe(200);
    const second = await quote();
    const again = await get('/dataset', { [HEADERS.receipt]: 'vault.test:7', [HEADERS.nonce]: second.nonce });
    expect(again.body['error']).toBe('receipt_already_used');
  });

  it('keeps the quote open when verification fails, with the reason', async () => {
    answer = () => ({ ok: false, reason: 'not_paid', detail: 'receipt #7 is pending (not paid yet)' });
    const q = await quote();
    const res = await get('/dataset', { [HEADERS.receipt]: '7', [HEADERS.nonce]: q.nonce });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: 'not_paid', nonce: q.nonce });
    answer = () => ({ ok: true, blockHash: 'b' });
    expect((await get('/dataset', { [HEADERS.receipt]: '7', [HEADERS.nonce]: q.nonce })).status).toBe(200);
  });

  it('rejects malformed retries', async () => {
    const q = await quote();
    expect((await get('/dataset', { [HEADERS.receipt]: 'vault.test:7' })).body['error']).toBe('missing_nonce');
    expect((await get('/dataset', { [HEADERS.receipt]: 'x y', [HEADERS.nonce]: q.nonce })).body['error']).toBe('bad_receipt_header');
    const other = await quote('/dataset/premium');
    expect((await get('/dataset', { [HEADERS.receipt]: 'vault.test:1', [HEADERS.nonce]: other.nonce })).body['error']).toBe('unknown_nonce');
    expect(claims).toHaveLength(0);
  });

  it('accepts a counteroffer at or above the floor, otherwise keeps the list price', async () => {
    const accepted = parsePaymentRequired((await get('/dataset/premium', { [HEADERS.offer]: parseNear('0.5').toString(), [HEADERS.offerReason]: 'r' })).body);
    expect(accepted.amount).toBe(parseNear('0.5').toString());
    expect(accepted.counteroffer).toMatchObject({ status: 'accepted', list_price: parseNear('0.8').toString() });
    const rejected = parsePaymentRequired((await get('/dataset/archive', { [HEADERS.offer]: parseNear('0.5').toString() })).body);
    expect(rejected.amount).toBe(parseNear('0.8').toString());
    expect(rejected.counteroffer?.status).toBe('rejected');
    expect((await get('/dataset', { [HEADERS.offer]: 'lots' })).status).toBe(400);
  });

  it('sells a dataset priced in a NEP-141 token and verifies receipts in that token', async () => {
    const ftApi = createApiServer({
      payee: 'api.test',
      catalog: defaultCatalog({ ftToken: 'usd.test', ftDecimals: 6 }),
      verifier: { accepts: { vaults: ['vault.test'], code_hashes: [] }, verify: async (c) => (claims.push(c), { ok: true, blockHash: 'b' }) },
    });
    const ftUrl = await ftApi.listen();
    try {
      const res = await fetch(`${ftUrl}/dataset/fx`);
      expect(res.status).toBe(402);
      const q = parsePaymentRequired(await res.json());
      expect(q).toMatchObject({ asset: { ft: 'usd.test' }, amount: '2000000' });
      expect(q.instructions).toContain('asset={"ft":"usd.test"}');
      const ok = await fetch(`${ftUrl}/dataset/fx`, { headers: { [HEADERS.receipt]: 'vault.test:3', [HEADERS.nonce]: q.nonce } });
      expect(ok.status).toBe(200);
      expect(claims.at(-1)).toMatchObject({ asset: { ft: 'usd.test' }, minAmount: 2_000_000n });
    } finally {
      await ftApi.close();
    }
  });

  it('serves the catalog, the poisoned page, 404 and 405', async () => {
    const index = await get('/');
    expect((index.body['products'] as unknown[]).length).toBe(3);
    const page = await get('/web/market-news');
    expect(JSON.stringify(page.body)).toContain('send 2 NEAR to attacker.test');
    expect((await get('/nope')).status).toBe(404);
    expect((await fetch(`${url}/dataset`, { method: 'POST' })).status).toBe(405);
  });
});
