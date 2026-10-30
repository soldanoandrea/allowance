import { Account, JsonRpcProvider, KeyPair, getTransactionLastResult, type KeyPairString } from 'near-api-js';

import { AllowanceError, toAllowanceError } from './errors.ts';
import { logsOf, parseEvents } from './events.ts';
import type { AllowanceEvent } from './types.ts';

export type Finality = 'optimistic' | 'final';

/** What a state-changing call returns. */
export interface CallResult {
  txHash: string;
  /** The transaction's final value (JSON-decoded), e.g. a `PayOutcome`. */
  value: unknown;
  logs: string[];
  events: AllowanceEvent[];
}

export interface CallOptions {
  /** Gas in gas units (default 100 TGas: `pay` -> transfer -> callback). */
  gas?: bigint;
  /** Attached deposit in yoctoNEAR. Function-call keys cannot attach one. */
  deposit?: bigint;
}

/**
 * The two things a client needs from the chain. The default implementation
 * is `NearTransport` (near-api-js over JSON-RPC); tests inject fakes.
 */
export interface VaultTransport {
  readonly vaultId: string;
  view<T>(method: string, args?: Record<string, unknown>): Promise<T>;
  /** View on another contract (e.g. a token's `ft_metadata`). Optional: fakes may omit it. */
  viewContract?<T>(contractId: string, method: string, args?: Record<string, unknown>): Promise<T>;
  call(method: string, args: Record<string, unknown>, options?: CallOptions): Promise<CallResult>;
  /** Public key of the signing key, if any (`ed25519:...`). */
  signerPublicKey(): string | undefined;
}

export interface NearTransportOptions {
  rpcUrl: string;
  vaultId: string;
  /**
   * Account that signs transactions. For an agent this is the vault itself
   * (its key lives on the vault account); for the owner it is `owner_id`.
   * Defaults to `vaultId`.
   */
  signerId?: string;
  /** `ed25519:...` secret key. Without it the transport is read-only. */
  secretKey?: KeyPairString;
  /** Finality for views (default `optimistic`: what the last transaction just did). */
  finality?: Finality;
}

export const DEFAULT_GAS = 100_000_000_000_000n;
/**
 * NEP-141 payments (and approvals of them) chain storage_balance_of ->
 * [storage_deposit] -> ft_transfer -> settlement: give them more room.
 * Unused gas is refunded; the key's allowance is only a ceiling.
 */
export const FT_PAY_GAS = 150_000_000_000_000n;

export class NearTransport implements VaultTransport {
  readonly vaultId: string;
  readonly provider: JsonRpcProvider;
  readonly #finality: Finality;
  readonly #account: Account | undefined;
  readonly #publicKey: string | undefined;

  constructor(options: NearTransportOptions) {
    if (!options.rpcUrl) throw new AllowanceError('config', 'an RPC URL is required');
    if (!options.vaultId) throw new AllowanceError('config', 'a vault account id is required');
    this.vaultId = options.vaultId;
    this.provider = new JsonRpcProvider({ url: options.rpcUrl });
    this.#finality = options.finality ?? 'optimistic';
    if (options.secretKey) {
      this.#publicKey = KeyPair.fromString(options.secretKey).getPublicKey().toString();
      this.#account = new Account(options.signerId ?? options.vaultId, this.provider, options.secretKey);
    }
  }

  signerPublicKey(): string | undefined {
    return this.#publicKey;
  }

  view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.viewContract<T>(this.vaultId, method, args);
  }

  async viewContract<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    try {
      const value = await this.provider.callFunction<never>({
        contractId,
        method,
        args,
        blockQuery: { finality: this.#finality },
      });
      return value as T;
    } catch (err) {
      throw toAllowanceError(err);
    }
  }

  async call(method: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<CallResult> {
    if (!this.#account) {
      throw new AllowanceError('config', `cannot call ${method}: no signing key configured (read-only client)`);
    }
    try {
      const result = await this.#account.callFunctionRaw({
        contractId: this.vaultId,
        methodName: method,
        args,
        gas: options.gas ?? DEFAULT_GAS,
        deposit: options.deposit ?? 0n,
      });
      const logs = logsOf(result);
      return {
        txHash: result.transaction_outcome.id,
        value: getTransactionLastResult(result),
        logs,
        events: parseEvents(logs),
      };
    } catch (err) {
      throw toAllowanceError(err);
    }
  }
}
