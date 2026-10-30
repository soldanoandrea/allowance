import type { KeyPairString } from 'near-api-js';

import { FT_PAY_GAS, NearTransport, type CallOptions, type VaultTransport } from './transport.ts';
import type { AgentId, AllowanceEvent, PayOutcome, Policy } from './types.ts';
import { assertAccountId } from './validate.ts';

export interface OwnerClientOptions {
  vaultId: string;
  /** `owner_id` (or `approver_id` for approve/deny). */
  ownerId: string;
  rpcUrl?: string;
  /** A full-access key of `ownerId` (never an agent key). */
  ownerKey?: KeyPairString;
  transport?: VaultTransport;
}

export interface OwnerTx<T = unknown> {
  value: T;
  txHash: string;
  events: AllowanceEvent[];
}

/**
 * Owner / approver actions. The contract checks `predecessor == owner_id`
 * (or `approver_id` for approve/deny), so these transactions are signed by
 * the owner's own account, never by a key on the vault.
 */
export class OwnerClient {
  readonly vaultId: string;
  readonly ownerId: string;
  readonly transport: VaultTransport;

  constructor(options: OwnerClientOptions) {
    assertAccountId(options.vaultId, 'vault');
    assertAccountId(options.ownerId, 'owner');
    this.vaultId = options.vaultId;
    this.ownerId = options.ownerId;
    this.transport =
      options.transport ??
      new NearTransport({
        rpcUrl: options.rpcUrl ?? '',
        vaultId: options.vaultId,
        signerId: options.ownerId,
        ...(options.ownerKey ? { secretKey: options.ownerKey } : {}),
      });
  }

  async #call<T>(method: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<OwnerTx<T>> {
    const result = await this.transport.call(method, args, options);
    return { value: result.value as T, txHash: result.txHash, events: result.events };
  }

  /** Fund the vault (anyone may deposit; >= 0.01 NEAR). Returns the income receipt id. */
  deposit(amountYocto: bigint): Promise<OwnerTx<number>> {
    return this.#call('deposit', {}, { deposit: amountYocto });
  }

  /**
   * Accept a NEP-141 token (needed before a token policy). `attachYocto`
   * (e.g. 0.00125 NEAR) makes the vault register itself on the token.
   */
  registerToken(tokenId: string, options: { minDeposit?: bigint; attachYocto?: bigint } = {}): Promise<OwnerTx<null>> {
    assertAccountId(tokenId, 'token');
    return this.#call(
      'register_token',
      { token_id: tokenId, ...(options.minDeposit !== undefined ? { min_deposit: options.minDeposit.toString() } : {}) },
      options.attachYocto !== undefined ? { deposit: options.attachYocto } : {},
    );
  }

  /** Move tokens out of the vault (to the owner unless `to` is given). */
  withdrawFt(tokenId: string, amount: bigint, to?: string): Promise<OwnerTx<unknown>> {
    assertAccountId(tokenId, 'token');
    return this.#call('withdraw_ft', { token_id: tokenId, amount: amount.toString(), ...(to ? { to } : {}) });
  }

  /** Register an agent; for a key agent the vault adds the key to its own account. */
  addAgent(agentId: AgentId, label: string, policy: Policy): Promise<OwnerTx<boolean>> {
    return this.#call('add_agent', { agent_id: agentId, label, policy });
  }

  setPolicy(agentId: AgentId, policy: Policy): Promise<OwnerTx<number>> {
    return this.#call('set_policy', { agent_id: agentId, policy });
  }

  removeAgent(agentId: AgentId): Promise<OwnerTx<null>> {
    return this.#call('remove_agent', { agent_id: agentId });
  }

  setDenylist(accounts: string[]): Promise<OwnerTx<null>> {
    return this.#call('set_denylist', { accounts });
  }

  /** Release a queued payment; the policy is evaluated again right now. */
  approve(pendingId: number): Promise<OwnerTx<PayOutcome>> {
    // Enough gas for a NEP-141 payment chain too; unused gas is refunded.
    return this.#call('approve', { pending_id: pendingId }, { gas: FT_PAY_GAS });
  }

  deny(pendingId: number): Promise<OwnerTx<null>> {
    return this.#call('deny', { pending_id: pendingId });
  }

  pause(): Promise<OwnerTx<null>> {
    return this.#call('pause', {});
  }

  unpause(): Promise<OwnerTx<null>> {
    return this.#call('unpause', {});
  }

  /** Pause + delete every agent key at the protocol level. */
  kill(): Promise<OwnerTx<AgentId[]>> {
    return this.#call('kill', {});
  }
}
