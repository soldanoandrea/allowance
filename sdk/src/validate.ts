import { AllowanceError } from './errors.ts';
import { isRequestHash } from './hash.ts';

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** NEAR account id rules: 2-64 chars, lowercase alphanumerics separated by `-`, `_` or `.`. */
export function isAccountId(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && ACCOUNT_ID.test(value);
}

export function assertAccountId(value: string, what: string): void {
  if (!isAccountId(value)) {
    throw new AllowanceError('config', `${what}: ${JSON.stringify(value)} is not a valid NEAR account id`);
  }
}

export function assertRequestHash(value: string): void {
  if (!isRequestHash(value)) {
    throw new AllowanceError('config', 'request_hash must be 32 bytes, base64 (sha256 of the request nonce)');
  }
}

export const MAX_MEMO_BYTES = 256;

export function assertMemo(memo: string): void {
  if (Buffer.byteLength(memo, 'utf8') > MAX_MEMO_BYTES) {
    throw new AllowanceError('config', `memo too long (max ${MAX_MEMO_BYTES} bytes)`);
  }
}
