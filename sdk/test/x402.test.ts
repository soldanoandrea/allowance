import { describe, expect, it } from 'vitest';

import { requestHash } from '../src/hash.ts';
import { PAYMENT_SCHEME, parsePaymentRequired, parseReceiptHeader, receiptHeader } from '../src/x402.ts';

function quote(overrides: Record<string, unknown> = {}) {
  const nonce = 'n0nce';
  return {
    scheme: PAYMENT_SCHEME,
    resource: '/dataset',
    description: 'candles',
    payee: 'api.test',
    asset: 'near',
    amount_yocto: '20000000000000000000000',
    nonce,
    request_hash_base64: requestHash(nonce),
    expires_at: '2026-10-31T00:00:00.000Z',
    accepts: { vaults: ['vault.test'], code_hashes: [] },
    instructions: 'pay',
    ...overrides,
  };
}

describe('402 quotes', () => {
  it('accepts a well-formed quote', () => {
    expect(parsePaymentRequired(quote()).payee).toBe('api.test');
  });

  it('refuses a quote whose request hash is not sha256(nonce)', () => {
    expect(() => parsePaymentRequired(quote({ request_hash_base64: requestHash('other') }))).toThrow(/sha256\(nonce\)/);
  });

  it('refuses malformed quotes', () => {
    expect(() => parsePaymentRequired(null)).toThrow();
    expect(() => parsePaymentRequired(quote({ scheme: 'x402' }))).toThrow(/scheme/);
    expect(() => parsePaymentRequired(quote({ payee: 'Not An Account' }))).toThrow(/payee/);
    expect(() => parsePaymentRequired(quote({ amount_yocto: '0' }))).toThrow(/amount/);
    expect(() => parsePaymentRequired(quote({ amount_yocto: '1.5' }))).toThrow(/amount/);
    expect(() => parsePaymentRequired(quote({ asset: { ft: 'usdc.test' } }))).toThrow(/asset/);
  });
});

describe('X-Allowance-Receipt header', () => {
  it('round-trips <vault>:<id>', () => {
    expect(parseReceiptHeader(receiptHeader('vault.test', 7))).toEqual({ vaultId: 'vault.test', receiptId: 7 });
  });

  it('accepts a bare id only with a default vault', () => {
    expect(parseReceiptHeader('7')).toBeNull();
    expect(parseReceiptHeader('7', 'vault.test')).toEqual({ vaultId: 'vault.test', receiptId: 7 });
  });

  it('rejects garbage', () => {
    for (const bad of ['vault.test:', ':7', 'vault.test:x', 'BAD:7', 'vault.test:-1']) expect(parseReceiptHeader(bad, 'vault.test'), bad).toBeNull();
  });
});
