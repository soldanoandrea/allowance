import { JsonRpcProvider } from 'near-api-js';

import { sleep } from './client.ts';
import { requestHash } from './hash.ts';
import type { Receipt } from './types.ts';

export interface VerifierOptions {
  rpcUrl: string;
  /** Vault accounts whose receipts are accepted as they are. */
  trustedVaults?: string[];
  /**
   * Contract code hashes (base58, as in `view_account.code_hash`): any vault
   * running exactly this code is accepted. Checked at the same block as the
   * `verify_receipt` call, so a vault cannot swap its code in between.
   */
  trustedCodeHashes?: string[];
  /** `final` (default) for real money; `optimistic` answers a block or two earlier. */
  finality?: 'final' | 'optimistic';
  /** How long to wait for a just-paid receipt to become visible (default 8 s). */
  waitMs?: number;
  intervalMs?: number;
}

export interface ReceiptClaim {
  vaultId: string;
  receiptId: number;
  /** The server's own account: the receipt must pay it. */
  payee: string;
  /** Price quoted for this nonce (yocto). */
  minAmount: bigint;
  /** Nonce the server issued; the receipt must carry sha256(nonce). */
  nonce: string;
}

export type VerifyResult =
  | { ok: true; blockHash: string }
  | { ok: false; reason: 'untrusted_vault' | 'untrusted_code' | 'not_paid' | 'mismatch' | 'not_found' | 'rpc_error'; detail: string };

/**
 * Payee-side receipt verification with one free view call, no facilitator.
 *
 * Why the trust list matters: `verify_receipt` is a view on the vault
 * account. A contract that is not Allowance could simply answer `true`, so
 * the server accepts a vault either by name (`trustedVaults`) or because it
 * runs audited Allowance code (`trustedCodeHashes`).
 */
export class ReceiptVerifier {
  readonly provider: JsonRpcProvider;
  readonly #trustedVaults: Set<string>;
  readonly #trustedCodeHashes: Set<string>;
  readonly #finality: 'final' | 'optimistic';
  readonly #waitMs: number;
  readonly #intervalMs: number;

  constructor(options: VerifierOptions) {
    this.provider = new JsonRpcProvider({ url: options.rpcUrl });
    this.#trustedVaults = new Set(options.trustedVaults ?? []);
    this.#trustedCodeHashes = new Set(options.trustedCodeHashes ?? []);
    this.#finality = options.finality ?? 'final';
    this.#waitMs = options.waitMs ?? 8_000;
    this.#intervalMs = options.intervalMs ?? 500;
  }

  /** What the 402 quote advertises in `accepts`. */
  get accepts(): { vaults: string[]; code_hashes: string[] } {
    return { vaults: [...this.#trustedVaults], code_hashes: [...this.#trustedCodeHashes] };
  }

  async verify(claim: ReceiptClaim): Promise<VerifyResult> {
    const byName = this.#trustedVaults.has(claim.vaultId);
    if (!byName && this.#trustedCodeHashes.size === 0) {
      return { ok: false, reason: 'untrusted_vault', detail: `vault ${claim.vaultId} is not accepted by this API` };
    }
    const deadline = Date.now() + this.#waitMs;
    for (;;) {
      let result: VerifyResult;
      try {
        result = await this.#verifyOnce(claim, byName);
      } catch (err) {
        result = { ok: false, reason: 'rpc_error', detail: (err as Error).message };
      }
      // A receipt that is still pending/approved, or not visible yet at this
      // finality, may settle in a moment: poll until the deadline.
      const retryable = !result.ok && (result.reason === 'not_paid' || result.reason === 'not_found');
      if (!retryable || Date.now() + this.#intervalMs > deadline) return result;
      await sleep(this.#intervalMs);
    }
  }

  async #verifyOnce(claim: ReceiptClaim, byName: boolean): Promise<VerifyResult> {
    const raw = await this.provider.callFunctionRaw({
      contractId: claim.vaultId,
      method: 'verify_receipt',
      args: {
        receipt_id: claim.receiptId,
        payee: claim.payee,
        min_amount: claim.minAmount.toString(),
        request_hash: requestHash(claim.nonce),
      },
      blockQuery: { finality: this.#finality },
    });
    if (!byName) {
      const account = await this.provider.viewAccount({ accountId: claim.vaultId, blockQuery: { blockId: raw.block_hash } });
      if (!this.#trustedCodeHashes.has(account.code_hash)) {
        return { ok: false, reason: 'untrusted_code', detail: `vault ${claim.vaultId} runs code ${account.code_hash}, not a trusted Allowance build` };
      }
    }
    const verified = JSON.parse(Buffer.from(raw.result).toString('utf8')) === true;
    if (verified) return { ok: true, blockHash: raw.block_hash };
    return this.#explain(claim, raw.block_hash);
  }

  /** `verify_receipt` is a boolean; read the receipt to tell the agent why. */
  async #explain(claim: ReceiptClaim, blockHash: string): Promise<VerifyResult> {
    const receipt = await this.provider.callFunction<never>({
      contractId: claim.vaultId,
      method: 'get_receipt',
      args: { receipt_id: claim.receiptId },
      blockQuery: { blockId: blockHash },
    }) as Receipt | null | undefined;
    if (!receipt) return { ok: false, reason: 'not_found', detail: `receipt #${claim.receiptId} not found on ${claim.vaultId}` };
    const status = receipt.status.status;
    if (status === 'pending' || status === 'approved') {
      return { ok: false, reason: 'not_paid', detail: `receipt #${claim.receiptId} is ${status} (not paid yet)` };
    }
    if (status !== 'paid') return { ok: false, reason: 'mismatch', detail: `receipt #${claim.receiptId} is ${status}` };
    if (receipt.payee !== claim.payee) return { ok: false, reason: 'mismatch', detail: `receipt #${claim.receiptId} pays ${receipt.payee}, not ${claim.payee}` };
    if (BigInt(receipt.amount) < claim.minAmount) return { ok: false, reason: 'mismatch', detail: `receipt #${claim.receiptId} pays ${receipt.amount} yocto, price is ${claim.minAmount}` };
    return { ok: false, reason: 'mismatch', detail: `receipt #${claim.receiptId} is bound to a different request (request_hash)` };
  }
}
