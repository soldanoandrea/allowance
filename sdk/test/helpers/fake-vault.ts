/**
 * In-memory stand-in for a vault (policy subset: allowlist, per-payment cap,
 * approval threshold, budget) behind the `VaultTransport` interface, plus a
 * matching `Verifier` for the demo API. Lets the agent loop, the API and the
 * CLI be tested together without a chain.
 */
import { requestHash, sameAsset, type CallResult, type ReceiptClaim, type VaultTransport, type VerifyResult } from '../../src/index.ts';
import type { PayOutcome, Receipt, Rejection, Simulation } from '../../src/types.ts';

export const AGENT_PK = 'ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcD4M';

export class FakeVault implements VaultTransport {
  readonly vaultId = 'vault.test';
  readonly receipts: Receipt[] = [];
  readonly calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  allow = ['api.test'];
  cap = 10n ** 24n;
  threshold: bigint | null = 5n * 10n ** 23n;
  budget = 2n * 10n ** 24n;
  spent = 0n;
  /** Auto-approve queued payments after this many polls of get_receipt (null = never). */
  approveAfterPolls: number | null = 1;
  #polls = 0;

  signerPublicKey(): string {
    return AGENT_PK;
  }

  evaluate(payee: string, amount: bigint): { verdict: Simulation['verdict']; reason: Rejection | null } {
    if (!this.allow.includes(payee)) return { verdict: 'block', reason: { code: 'not_allowlisted', payee } };
    if (amount > this.cap) return { verdict: 'block', reason: { code: 'over_per_tx_cap', cap: this.cap.toString() } };
    if (this.spent + amount > this.budget) {
      return { verdict: 'block', reason: { code: 'over_budget', remaining: (this.budget - this.spent).toString(), resets_at_ns: '0' } };
    }
    if (this.threshold !== null && amount > this.threshold) return { verdict: 'needs_approval', reason: null };
    return { verdict: 'allow', reason: null };
  }

  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, args });
    switch (method) {
      case 'simulate': {
        const { verdict, reason } = this.evaluate(String(args['payee']), BigInt(String(args['amount'])));
        const sim: Simulation = {
          verdict,
          reason,
          agent: { key: AGENT_PK },
          policy_version: 1,
          remaining_budget: (this.budget - this.spent).toString(),
          budget_resets_at_ns: '0',
          vault_available: '5000000000000000000000000',
          block_timestamp_ns: '1793391009000000000',
        };
        return sim as T;
      }
      case 'get_agent':
        return { policy: { per_tx_cap: this.cap.toString(), approval_threshold: this.threshold?.toString() ?? null } } as T;
      case 'get_receipt': {
        const r = this.receipts[Number(args['receipt_id'])];
        if (r && r.status.status === 'pending' && this.approveAfterPolls !== null && ++this.#polls > this.approveAfterPolls) {
          r.status = { status: 'paid' };
          r.approved_by = 'owner.test';
          this.spent += BigInt(r.amount);
        }
        return (r ? structuredClone(r) : null) as T;
      }
      default:
        throw new Error(`FakeVault: view ${method} not implemented`);
    }
  }

  async call(method: string, args: Record<string, unknown>): Promise<CallResult> {
    this.calls.push({ method, args });
    const txHash = `tx${this.calls.length}`;
    if (method === 'pay') {
      const payee = String(args['payee']);
      const amount = BigInt(String(args['amount']));
      const { verdict, reason } = this.evaluate(payee, amount);
      const id = this.receipts.length;
      const receipt: Receipt = {
        id,
        kind: 'pay',
        status: { status: 'paid' },
        agent: { key: AGENT_PK },
        payee,
        amount: amount.toString(),
        asset: (args['asset'] as Receipt['asset'] | undefined) ?? 'near',
        memo: String(args['memo'] ?? ''),
        request_hash: (args['request_hash'] as string | undefined) ?? null,
        ts_ns: '1793391009000000000',
        policy_version: 1,
        delivered: null,
        pending_id: null,
        approved_by: null,
        storage_deposit: null,
        split: [],
      };
      let outcome: PayOutcome;
      if (verdict === 'block') {
        receipt.status = { status: 'rejected', reason: reason! };
        outcome = { outcome: 'rejected', receipt_id: id, reason: reason! };
      } else if (verdict === 'needs_approval') {
        receipt.status = { status: 'pending' };
        receipt.pending_id = 0;
        outcome = { outcome: 'needs_approval', receipt_id: id, pending_id: 0, expires_at_ns: '1' };
      } else {
        this.spent += amount;
        outcome = { outcome: 'paid', receipt_id: id };
      }
      this.receipts.push(receipt);
      return { txHash, value: outcome, logs: [], events: [{ standard: 'allowance', version: '1.0.0', event: `payment_${outcome.outcome}`, data: {} }] };
    }
    if (method === 'confirm_delivery') {
      const r = this.receipts[Number(args['receipt_id'])];
      if (!r) throw new Error('unknown receipt');
      r.delivered = Boolean(args['passed']);
      return { txHash, value: null, logs: [], events: [] };
    }
    throw new Error(`FakeVault: call ${method} not implemented`);
  }

  /** What `verify_receipt` would answer. */
  verify(claim: ReceiptClaim): boolean {
    const r = this.receipts[claim.receiptId];
    return (
      !!r &&
      claim.vaultId === this.vaultId &&
      r.kind === 'pay' &&
      r.status.status === 'paid' &&
      r.payee === claim.payee &&
      sameAsset(r.asset, claim.asset ?? 'near') &&
      BigInt(r.amount) >= claim.minAmount &&
      r.request_hash === requestHash(claim.nonce)
    );
  }
}

/** Demo-API verifier backed by a FakeVault. */
export function fakeVerifier(vault: FakeVault) {
  const claims: ReceiptClaim[] = [];
  return {
    claims,
    accepts: { vaults: [vault.vaultId], code_hashes: [] as string[] },
    async verify(claim: ReceiptClaim): Promise<VerifyResult> {
      claims.push(claim);
      if (claim.vaultId !== vault.vaultId) return { ok: false, reason: 'untrusted_vault', detail: 'not trusted' };
      return vault.verify(claim) ? { ok: true, blockHash: 'blockhash' } : { ok: false, reason: 'mismatch', detail: 'verify_receipt returned false' };
    },
  };
}
