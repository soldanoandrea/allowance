import { describe, expect, it } from 'vitest';

import { logsOf, parseEvents } from '../src/events.ts';
import { isRequestHash, newNonce, requestHash } from '../src/hash.ts';

describe('request hash', () => {
  it('is base64(sha256(utf8(nonce)))', () => {
    expect(requestHash('abc')).toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
    expect(isRequestHash(requestHash(newNonce()))).toBe(true);
  });

  it('recognises 32-byte base64 only', () => {
    expect(isRequestHash(Buffer.alloc(31).toString('base64'))).toBe(false);
    expect(isRequestHash(Buffer.alloc(33).toString('base64'))).toBe(false);
    expect(isRequestHash('not base64 at all, but long enough to be 44 c')).toBe(false);
  });

  it('issues distinct url-safe nonces', () => {
    const a = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newNonce()).not.toBe(a);
  });
});

describe('NEP-297 events', () => {
  const ev = (event: string, standard = 'allowance') => `EVENT_JSON:${JSON.stringify({ standard, version: '1.0.0', event, data: { receipt_id: 1 } })}`;

  it('keeps only allowance events, ignoring other logs', () => {
    const events = parseEvents([ev('payment_paid'), 'plain log', ev('nft_mint', 'nep171'), 'EVENT_JSON:{broken', ev('delivery_confirmed')]);
    expect(events.map((e) => e.event)).toEqual(['payment_paid', 'delivery_confirmed']);
    expect(events[0]?.data).toEqual({ receipt_id: 1 });
  });

  it('collects logs from the transaction and every receipt outcome in order', () => {
    expect(
      logsOf({
        transaction_outcome: { outcome: { logs: ['a'] } },
        receipts_outcome: [{ outcome: { logs: ['b', 'c'] } }, { outcome: { logs: [] } }, { outcome: { logs: ['d'] } }],
      }),
    ).toEqual(['a', 'b', 'c', 'd']);
  });
});
