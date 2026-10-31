import type { KeyPairString } from 'near-api-js';

import { AllowanceError } from './errors.ts';
import { NearTransport, type Finality, type VaultTransport } from './transport.ts';
import { assertAccountId } from './validate.ts';

/** NEP-297 event of the factory (standard "allowance_factory"). */
export interface FactoryEvent {
  standard: 'allowance_factory';
  version: string;
  event: 'vault_created' | 'vault_creation_failed' | 'vault_code_set' | (string & {});
  data: Record<string, unknown>;
}

/** `get_info` of the factory. */
export interface FactoryInfo {
  owner_id: string;
  /** base58 sha256 of the vault wasm every new vault runs (a global contract by hash). */
  vault_code_hash: string;
  /** Smallest deposit `create_vault` accepts, yoctoNEAR. */
  min_deposit: string;
  vaults: number;
}

/** A vault the factory created (`get_vault`). */
export interface FactoryVaultRecord {
  owner_id: string;
  code_hash: string;
  created_by: string;
  created_at_ns: string;
}

/** One row of `get_vaults`. */
export interface FactoryVault extends FactoryVaultRecord {
  vault_id: string;
}

export interface FactoryClientOptions {
  /** The factory contract account, e.g. `factory.you.testnet`. */
  factoryId: string;
  /** JSON-RPC endpoint. Required unless `transport` is given. */
  rpcUrl?: string;
  /** Account that signs `create_vault` and pays the deposit (often the future owner). */
  signerId?: string;
  /** A full-access key of `signerId`. Omit for a read-only client (info, vaults). */
  signerKey?: KeyPairString;
  /** Inject a transport (tests, custom signers). Its `vaultId` is the factory. */
  transport?: VaultTransport;
  finality?: Finality;
}

export interface CreateVaultRequest {
  /** One lowercase label: the vault becomes `<name>.<factory>`. */
  name: string;
  /** Vault owner (default: the signer). */
  ownerId?: string;
  /** Second account allowed to approve / deny queued payments. */
  approverId?: string;
  /** How long an approval request stays open, nanoseconds (vault default 24 h). */
  approvalTtlNs?: bigint | string;
  /** Gas allowance of each agent key the vault adds, yoctoNEAR (vault default 1 NEAR). */
  keyGasAllowance?: bigint;
  /** Becomes the vault's balance, yoctoNEAR. Default: the factory's `min_deposit`. */
  deposit?: bigint;
  /** Gas for the transaction (default 100 TGas: create + init + callback). */
  gas?: bigint;
}

export interface CreateVaultResult {
  /** `<name>.<factory>`. */
  vaultId: string;
  /** false: the creation batch failed and the deposit went back to the signer. */
  created: boolean;
  ownerId: string;
  deposit: bigint;
  /** The global contract hash the vault runs (from the `vault_created` event). */
  codeHash: string | undefined;
  txHash: string;
  events: FactoryEvent[];
}

const PREFIX = 'EVENT_JSON:';
const LABEL = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
/** Default gas of `create_vault`: the batch (create, transfer, use global code, `new` 20 TGas) and a 10 TGas callback. */
export const CREATE_VAULT_GAS = 100_000_000_000_000n;

/** Extract the factory's NEP-297 events (standard "allowance_factory") from execution logs. */
export function parseFactoryEvents(logs: readonly string[]): FactoryEvent[] {
  const events: FactoryEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith(PREFIX)) continue;
    try {
      const v = JSON.parse(line.slice(PREFIX.length)) as Record<string, unknown>;
      if (v['standard'] === 'allowance_factory' && typeof v['event'] === 'string' && typeof v['data'] === 'object' && v['data'] !== null) {
        events.push(v as unknown as FactoryEvent);
      }
    } catch {
      // Another contract's log line.
    }
  }
  return events;
}

/** The factory's rule for `name`: one label of lowercase letters, digits, `-` or `_`, at most 32 bytes. */
export function isVaultName(name: string): boolean {
  return LABEL.test(name);
}

/**
 * Client of the vault factory (`factory/`): creates vaults that run the
 * Allowance code as a NEAR global contract, and lists them. The new vault
 * has no access key; its owner manages it with `OwnerClient`.
 */
export class FactoryClient {
  readonly factoryId: string;
  readonly signerId: string | undefined;
  readonly transport: VaultTransport;

  constructor(options: FactoryClientOptions) {
    assertAccountId(options.factoryId, 'factory');
    if (options.signerId !== undefined) assertAccountId(options.signerId, 'signer');
    if (options.signerKey && !options.signerId) {
      throw new AllowanceError('config', 'a signer key needs its account: pass signerId');
    }
    this.factoryId = options.factoryId;
    this.signerId = options.signerId;
    this.transport =
      options.transport ??
      new NearTransport({
        rpcUrl: options.rpcUrl ?? '',
        vaultId: options.factoryId,
        ...(options.signerId ? { signerId: options.signerId } : {}),
        ...(options.signerKey ? { secretKey: options.signerKey } : {}),
        ...(options.finality ? { finality: options.finality } : {}),
      });
  }

  /** `<name>.<factory>`, after checking the name the way the factory does. */
  vaultIdFor(name: string): string {
    if (!isVaultName(name)) {
      throw new AllowanceError('config', `vault name ${JSON.stringify(name)}: use one label of lowercase letters, digits, - or _ (max 32)`);
    }
    const id = `${name}.${this.factoryId}`;
    assertAccountId(id, 'vault');
    return id;
  }

  info(): Promise<FactoryInfo> {
    return this.transport.view<FactoryInfo>('get_info');
  }

  /** The factory's record of `vaultId`, or null if it did not create it. */
  vault(vaultId: string): Promise<FactoryVaultRecord | null> {
    assertAccountId(vaultId, 'vault');
    return this.transport.view<FactoryVaultRecord | null>('get_vault', { vault_id: vaultId });
  }

  /** Vaults in creation order (paged; the factory's default page is 50). */
  vaults(options: { fromIndex?: number; limit?: number } = {}): Promise<FactoryVault[]> {
    return this.transport.view<FactoryVault[]>('get_vaults', {
      ...(options.fromIndex !== undefined ? { from_index: options.fromIndex } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
  }

  /**
   * Create `<name>.<factory>` (one transaction: create account, transfer the
   * deposit, use the global vault code, `new`). Inputs are checked before
   * anything is signed; a deposit below the factory's `min_deposit` is
   * refused locally. A failed creation is a value (`created: false`, the
   * factory refunds the deposit), not an exception.
   */
  async createVault(request: CreateVaultRequest): Promise<CreateVaultResult> {
    const vaultId = this.vaultIdFor(request.name);
    const signerId = this.signerId;
    if (!signerId) throw new AllowanceError('config', 'cannot create a vault: no signer configured (read-only client)');
    const ownerId = request.ownerId ?? signerId;
    assertAccountId(ownerId, 'owner');
    if (request.approverId !== undefined) assertAccountId(request.approverId, 'approver');
    const ttl = request.approvalTtlNs === undefined ? undefined : BigInt(request.approvalTtlNs);
    if (ttl !== undefined && ttl <= 0n) throw new AllowanceError('config', 'approval TTL must be > 0');
    if (request.keyGasAllowance !== undefined && request.keyGasAllowance <= 0n) {
      throw new AllowanceError('config', 'key gas allowance must be > 0');
    }
    const minDeposit = BigInt((await this.info()).min_deposit);
    const deposit = request.deposit ?? minDeposit;
    if (deposit < minDeposit) {
      throw new AllowanceError('config', `deposit ${deposit} yoctoNEAR is below the factory's minimum ${minDeposit}`);
    }
    const result = await this.transport.call(
      'create_vault',
      {
        name: request.name,
        owner_id: ownerId,
        ...(request.approverId !== undefined ? { approver_id: request.approverId } : {}),
        ...(ttl !== undefined ? { approval_ttl_ns: ttl.toString() } : {}),
        ...(request.keyGasAllowance !== undefined ? { key_gas_allowance: request.keyGasAllowance.toString() } : {}),
      },
      { deposit, gas: request.gas ?? CREATE_VAULT_GAS },
    );
    const events = parseFactoryEvents(result.logs);
    const created = events.find((e) => e.event === 'vault_created');
    const codeHash = created && typeof created.data['code_hash'] === 'string' ? created.data['code_hash'] : undefined;
    return { vaultId, created: result.value === true, ownerId, deposit, codeHash, txHash: result.txHash, events };
  }
}
