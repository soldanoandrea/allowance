import { createHash, randomBytes } from 'node:crypto';

/**
 * `request_hash` binds a vault receipt to one HTTP request: the paid API
 * issues a random `nonce`, the agent pays with
 * `request_hash = sha256(utf8(nonce))` (32 bytes, base64 in JSON) and the API
 * checks the receipt with `verify_receipt(..., request_hash)`.
 */
export function requestHash(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('base64');
}

/** A fresh 128-bit nonce, base64url (safe in headers and URLs). */
export function newNonce(): string {
  return randomBytes(16).toString('base64url');
}

/** Constant-shape check that a base64 string decodes to exactly 32 bytes. */
export function isRequestHash(value: string): boolean {
  return /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').length === 32;
}
