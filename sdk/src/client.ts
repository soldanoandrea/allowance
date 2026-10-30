import type { KeyPairString } from 'near-api-js';

import { isNear, setTokenDisplay, tokenOf } from './asset.ts';
import { AllowanceError } from './errors.ts';
import { FT_PAY_GAS, NearTransport, type Finality, type VaultTransport } from './transport.ts';
import type {
  AgentId,
  AgentView,
  AllowanceEvent,
  Asset,
  FtMetadata,
  PayOutcome,
  Pending,
  PingResponse,
  Receipt,
  Simulation,
  TokenView,
  VaultInfo,
} from './types.ts';
import { toYocto } from './units.ts';
import { assertAccountId, assertMemo, assertRequestHash } from './validate.ts';

export interface AllowanceClientOptions {
  /** The vault contract account, e.g. `vault.you.testnet`. */
  vaultId: string;
  /** JSON-RPC endpoint. Required unless `transport` is given. */
  rpcUrl?: string;
  /**
   * The agent's function-call key (`ed25519:...`). It signs as the vault
   * account itself, because that is where the key lives. Omit it for a
   * read-only client (views only: simulate, receipts, verifyReceipt...).
   */
  agentKey?: KeyPairString;
  /** Inject a transport (tests, custom signers). */
  transport?: VaultTransport;
  finality?: Finality;
}

export interface PayRequest {
  payee: string;
  /** Base units of `asset` (bigint or decimal string). Use `parseNear("0.02")` for NEAR. */
  amount: bigint | string;
  /** Default NEAR. Must be the agent policy's asset. */
  asset?: Asset;
  memo?: string;
  /** base64 of 32 bytes, normally `requestHash(nonce)` from a 402 quote. */
  requestHash?: string;
}

export interface PayResult {
  outcome: PayOutcome;
  txHash: string;
  events: AllowanceEvent[];
}

export interface TxInfo {
  txHash: string;
  events: AllowanceEvent[];
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Called after every poll with the current receipt (progress logs). */
  onPoll?: (receipt: Receipt) => void;
  signal?: AbortSignal;
}

const PAGE = 50;
const SETTLED = new Set(['paid', 'failed', 'rejected', 'denied', 'expired']);

/**
 * Agent-side client of an Allowance vault.
 *
 * The agent holds only a function-call key on the vault account, limited by
 * the protocol to `pay`, `confirm_delivery` and `ping`; every amount, payee
 * and time limit is the contract's policy. `simulate` is a free view: call it
 * before `pay` and refuse on `block`.
 */
export class AllowanceClient {
  readonly vaultId: string;
  readonly transport: VaultTransport;

  constructor(options: AllowanceClientOptions) {
    assertAccountId(options.vaultId, 'vault');
    this.vaultId = options.vaultId;
    if (options.transport) {
      this.transport = options.transport;
    } else {
      if (!options.rpcUrl) throw new AllowanceError('config', 'rpcUrl is required');
      this.transport = new NearTransport({
        rpcUrl: options.rpcUrl,
        vaultId: options.vaultId,
        ...(options.agentKey ? { secretKey: options.agentKey } : {}),
        ...(options.finality ? { finality: options.finality } : {}),
      });
    }
  }

  /** `{ key: "ed25519:..." }` for the configured agent key, if any. */
  get agentId(): AgentId | undefined {
    const key = this.transport.signerPublicKey();
    return key ? { key } : undefined;
  }

  #requireAgentId(): AgentId {
    const id = this.agentId;
    if (!id) throw new AllowanceError('config', 'no agent key configured: pass agentId explicitly or configure a key');
    return id;
  }

  // ------------------------------------------------------------------
  // Agent actions (signed with the function-call key)
  // ------------------------------------------------------------------

  /** Free dry-run: would `pay(payee, amount, asset)` go through right now? */
  async simulate(payee: string, amount: bigint | string, options: { agentId?: AgentId; asset?: Asset } = {}): Promise<Simulation> {
    assertAccountId(payee, 'payee');
    return this.transport.view<Simulation>('simulate', {
      agent_id: options.agentId ?? this.#requireAgentId(),
      payee,
      amount: toYocto(amount).toString(),
      ...assetArg(options.asset),
    });
  }

  /**
   * Pay `amount` to `payee` under the agent's policy. Never throws for policy
   * reasons: a refusal is `{ outcome: "rejected", reason }` with a receipt,
   * a large payment is `{ outcome: "needs_approval", pending_id }`.
   */
  async pay(request: PayRequest): Promise<PayResult> {
    assertAccountId(request.payee, 'payee');
    const amount = toYocto(request.amount);
    if (amount <= 0n) throw new AllowanceError('config', 'amount must be > 0');
    if (request.memo !== undefined) assertMemo(request.memo);
    if (request.requestHash !== undefined) assertRequestHash(request.requestHash);
    const result = await this.transport.call(
      'pay',
      {
        payee: request.payee,
        amount: amount.toString(),
        ...assetArg(request.asset),
        ...(request.memo !== undefined ? { memo: request.memo } : {}),
        ...(request.requestHash !== undefined ? { request_hash: request.requestHash } : {}),
      },
      isNear(request.asset) ? {} : { gas: FT_PAY_GAS },
    );
    return { outcome: asPayOutcome(result.value), txHash: result.txHash, events: result.events };
  }

  /** Record whether what the agent paid for was delivered (once per receipt). */
  async confirmDelivery(receiptId: number, passed: boolean): Promise<TxInfo> {
    const result = await this.transport.call('confirm_delivery', { receipt_id: receiptId, passed });
    return { txHash: result.txHash, events: result.events };
  }

  /** Liveness check signed with the key: tells the agent how the vault sees it. */
  async ping(): Promise<PingResponse & { txHash: string }> {
    const result = await this.transport.call('ping', {});
    return { ...(result.value as PingResponse), txHash: result.txHash };
  }

  // ------------------------------------------------------------------
  // Views (free, no key needed)
  // ------------------------------------------------------------------

  /**
   * Payee-side check: is receipt `receiptId` a paid payment to `payee` of at
   * least `minAmount` of `asset` (default NEAR)?
   */
  async verifyReceipt(args: {
    receiptId: number;
    payee: string;
    minAmount: bigint | string;
    requestHash?: string;
    asset?: Asset;
  }): Promise<boolean> {
    assertAccountId(args.payee, 'payee');
    if (args.requestHash !== undefined) assertRequestHash(args.requestHash);
    const ok = await this.transport.view<boolean>('verify_receipt', {
      receipt_id: args.receiptId,
      payee: args.payee,
      min_amount: toYocto(args.minAmount).toString(),
      ...(args.requestHash !== undefined ? { request_hash: args.requestHash } : {}),
      ...assetArg(args.asset),
    });
    return ok === true;
  }

  /** A NEP-141 token registered with the vault, with the balance the vault accounts for. */
  async token(tokenId: string): Promise<TokenView | null> {
    assertAccountId(tokenId, 'token');
    return (await this.transport.view<TokenView | null>('get_token', { token_id: tokenId })) ?? null;
  }

  /**
   * NEP-148 metadata of a token, read from the token contract itself; also
   * registers its symbol and decimals for `formatAmount`/`parseAssetAmount`.
   */
  async ftMetadata(tokenId: string): Promise<FtMetadata> {
    assertAccountId(tokenId, 'token');
    if (!this.transport.viewContract) throw new AllowanceError('config', 'this transport cannot read other contracts');
    const meta = await this.transport.viewContract<FtMetadata>(tokenId, 'ft_metadata', {});
    if (!meta || typeof meta.symbol !== 'string' || !Number.isInteger(meta.decimals)) {
      throw new AllowanceError('contract_panic', `${tokenId} did not return NEP-148 metadata`);
    }
    setTokenDisplay(tokenId, { symbol: meta.symbol, decimals: meta.decimals });
    return meta;
  }

  vault(): Promise<VaultInfo> {
    return this.transport.view<VaultInfo>('get_vault');
  }

  async agent(agentId?: AgentId): Promise<AgentView | null> {
    return (await this.transport.view<AgentView | null>('get_agent', { agent_id: agentId ?? this.#requireAgentId() })) ?? null;
  }

  agents(): Promise<AgentView[]> {
    return this.transport.view<AgentView[]>('get_agents', { from_index: 0, limit: 100 });
  }

  async receipt(receiptId: number): Promise<Receipt | null> {
    return (await this.transport.view<Receipt | null>('get_receipt', { receipt_id: receiptId })) ?? null;
  }

  /**
   * Receipts in id order. Without `limit`, pages through every stored
   * receipt from `fromId` (default: the oldest one) to the newest.
   */
  async receipts(options: { fromId?: number; limit?: number } = {}): Promise<Receipt[]> {
    if (options.limit !== undefined) {
      return this.transport.view<Receipt[]>('get_receipts', {
        ...(options.fromId !== undefined ? { from_id: options.fromId } : {}),
        limit: options.limit,
      });
    }
    const info = await this.vault();
    const out: Receipt[] = [];
    for (let from = options.fromId ?? info.first_receipt_id; from < info.next_receipt_id; from += PAGE) {
      out.push(...(await this.transport.view<Receipt[]>('get_receipts', { from_id: from, limit: PAGE })));
    }
    return out;
  }

  pending(): Promise<Pending[]> {
    return this.transport.view<Pending[]>('get_pending');
  }

  /**
   * Poll a receipt until it leaves `pending`/`approved` (a human approved or
   * denied it, it expired, or the transfer settled). Resolves with the
   * settled receipt; rejects on timeout.
   */
  async waitForSettlement(receiptId: number, options: WaitOptions = {}): Promise<Receipt> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const intervalMs = options.intervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const receipt = await this.receipt(receiptId);
      if (!receipt) throw new AllowanceError('contract_panic', `receipt #${receiptId} does not exist`);
      options.onPoll?.(receipt);
      if (SETTLED.has(receipt.status.status)) return receipt;
      if (Date.now() + intervalMs > deadline) {
        throw new AllowanceError('rpc', `receipt #${receiptId} still ${receipt.status.status} after ${timeoutMs} ms`);
      }
      await sleep(intervalMs, options.signal);
    }
  }
}

/** `{asset}` for a token, nothing for NEAR (the contract's default). */
function assetArg(asset: Asset | undefined): { asset?: Asset } {
  return tokenOf(asset) === null ? {} : { asset: asset as Asset };
}

function asPayOutcome(value: unknown): PayOutcome {
  if (typeof value === 'object' && value !== null && 'outcome' in value && 'receipt_id' in value) {
    return value as PayOutcome;
  }
  throw new AllowanceError('contract_panic', `unexpected pay result: ${JSON.stringify(value)}`);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
