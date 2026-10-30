/**
 * The HTTP 402 payment flow between an agent and a paid API, settled through
 * an Allowance vault receipt instead of a facilitator. See docs/PAYMENT_FLOW.md.
 *
 *   GET /dataset                                  -> 402 PaymentRequired{payee, amount_yocto, nonce, request_hash_base64}
 *   vault.pay(payee, amount, request_hash)         -> receipt #N (paid)
 *   GET /dataset  X-Allowance-Receipt: vault:N
 *                 X-Allowance-Nonce: <nonce>        -> server: verify_receipt(N, payee, amount, sha256(nonce)) -> 200
 *
 * One counteroffer: `X-Allowance-Offer: <yocto>` (+ `X-Allowance-Offer-Reason`)
 * on the unpaid request; the server answers with a new 402 quote at the offer
 * (accepted) or at the list price (rejected).
 */
import { isRequestHash, requestHash } from './hash.ts';
import { isAccountId } from './validate.ts';

export const PAYMENT_SCHEME = 'allowance-receipt/v1';

export const HEADERS = {
  receipt: 'x-allowance-receipt',
  nonce: 'x-allowance-nonce',
  offer: 'x-allowance-offer',
  offerReason: 'x-allowance-offer-reason',
} as const;

export interface Counteroffer {
  status: 'accepted' | 'rejected';
  offered_yocto: string;
  list_price_yocto: string;
  reason: string;
}

/** Body of a 402 response. */
export interface PaymentRequired {
  scheme: typeof PAYMENT_SCHEME;
  resource: string;
  description: string;
  payee: string;
  asset: 'near';
  amount_yocto: string;
  /** Single-use, issued by the server; the agent echoes it back. */
  nonce: string;
  /** `base64(sha256(utf8(nonce)))`: pass it to `pay` as `request_hash`. */
  request_hash_base64: string;
  expires_at: string;
  /** Vaults the server accepts receipts from (account ids and/or a contract code hash). */
  accepts: { vaults: string[]; code_hashes: string[] };
  instructions: string;
  counteroffer?: Counteroffer;
  /** Set when a retry with a receipt was refused (and why). */
  error?: string;
  error_detail?: string;
}

/** Validate an untrusted 402 body. Throws with the first problem found. */
export function parsePaymentRequired(body: unknown): PaymentRequired {
  if (typeof body !== 'object' || body === null) throw new Error('402 body is not a JSON object');
  const b = body as Record<string, unknown>;
  const str = (k: string): string => {
    const v = b[k];
    if (typeof v !== 'string' || v.length === 0) throw new Error(`402 body: "${k}" missing`);
    return v;
  };
  if (b['scheme'] !== PAYMENT_SCHEME) throw new Error(`402 body: unsupported scheme ${JSON.stringify(b['scheme'])}`);
  const payee = str('payee');
  if (!isAccountId(payee)) throw new Error(`402 body: payee ${JSON.stringify(payee)} is not an account id`);
  const amount = str('amount_yocto');
  if (!/^\d+$/.test(amount) || BigInt(amount) === 0n) throw new Error('402 body: amount_yocto must be a positive integer string');
  const nonce = str('nonce');
  const hash = str('request_hash_base64');
  if (!isRequestHash(hash)) throw new Error('402 body: request_hash_base64 is not 32 bytes of base64');
  // Do not trust the server's arithmetic: the hash must be sha256(nonce).
  if (requestHash(nonce) !== hash) throw new Error('402 body: request_hash_base64 != sha256(nonce)');
  if (b['asset'] !== 'near') throw new Error('402 body: only asset "near" is supported');
  return body as PaymentRequired;
}

/** `X-Allowance-Receipt` value: `<vault account>:<receipt id>`. */
export function receiptHeader(vaultId: string, receiptId: number): string {
  return `${vaultId}:${receiptId}`;
}

/**
 * Parse `X-Allowance-Receipt`. Accepts `<vault>:<id>` and, when the server
 * has a default vault, a bare `<id>`. Account ids cannot contain ":".
 */
export function parseReceiptHeader(value: string, defaultVault?: string): { vaultId: string; receiptId: number } | null {
  const trimmed = value.trim();
  const sep = trimmed.lastIndexOf(':');
  const vaultId = sep === -1 ? defaultVault : trimmed.slice(0, sep);
  const idText = sep === -1 ? trimmed : trimmed.slice(sep + 1);
  if (!vaultId || !isAccountId(vaultId) || !/^\d{1,15}$/.test(idText)) return null;
  return { vaultId, receiptId: Number(idText) };
}
