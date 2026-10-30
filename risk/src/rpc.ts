/**
 * A minimal NEAR JSON-RPC client over `fetch`, with the error causes the risk
 * checks branch on (account missing, block missing, history pruned).
 */

export type RpcErrorKind = 'unknown_account' | 'unknown_block' | 'unavailable_block' | 'other';

export class RpcError extends Error {
  readonly kind: RpcErrorKind;
  readonly data: unknown;
  constructor(kind: RpcErrorKind, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.kind = kind;
    this.data = data;
  }
}

export interface AccountView {
  amount: string;
  code_hash: string;
  storage_usage: number;
  block_height: number;
  block_hash: string;
}

export interface BlockHeader {
  height: number;
  hash: string;
  /** Nanoseconds since the epoch, as a decimal string. */
  timestamp_nanosec: string;
}

export type BlockRef = { finality: 'final' | 'optimistic' } | { block_id: number | string };

/** `code_hash` of an account without a contract (32 zero bytes, base58). */
export const NO_CODE = '11111111111111111111111111111111';

let nextId = 1;

export class Rpc {
  readonly url: string;
  readonly #fetch: typeof fetch;

  constructor(url: string, fetchImpl?: typeof fetch) {
    this.url = url;
    this.#fetch = fetchImpl ?? ((...args) => fetch(...args));
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    const res = await this.#fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: `risk-${nextId++}`, method, params }),
    });
    let body: { result?: T & { error?: string }; error?: { name?: string; cause?: { name?: string }; data?: unknown; message?: string } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new RpcError('other', `${method}: HTTP ${res.status}`);
    }
    if (body.error) {
      const cause = body.error.cause?.name ?? body.error.name ?? '';
      const text = `${cause} ${JSON.stringify(body.error.data ?? body.error.message ?? '')}`;
      throw new RpcError(classify(text), `${method}: ${text.trim()}`, body.error);
    }
    if (body.result && typeof body.result === 'object' && 'error' in body.result && typeof body.result.error === 'string') {
      throw new RpcError(classify(body.result.error), `${method}: ${body.result.error}`, body.result);
    }
    return body.result as T;
  }

  /** `view_account`, or null when the account does not exist at that block. */
  async account(accountId: string, at: BlockRef = { finality: 'final' }): Promise<AccountView | null> {
    try {
      return await this.call<AccountView>('query', { request_type: 'view_account', account_id: accountId, ...at });
    } catch (err) {
      if (err instanceof RpcError && err.kind === 'unknown_account') return null;
      throw err;
    }
  }

  async block(at: BlockRef = { finality: 'final' }): Promise<BlockHeader> {
    const block = await this.call<{ header: BlockHeader }>('block', at);
    return block.header;
  }

  /** First height the node knows of (genesis on an archival node). */
  async genesisHeight(): Promise<number> {
    try {
      const genesis = await this.call<{ genesis_height?: number }>('EXPERIMENTAL_genesis_config', {});
      return typeof genesis.genesis_height === 'number' ? genesis.genesis_height : 0;
    } catch {
      return 0;
    }
  }

  /** A JSON view call on a contract at the final block. */
  async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.call<{ result: number[] }>('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    const text = Buffer.from(result.result).toString('utf8');
    return (text ? JSON.parse(text) : null) as T;
  }
}

function classify(text: string): RpcErrorKind {
  if (/UNKNOWN_ACCOUNT|does not exist while viewing/i.test(text)) return 'unknown_account';
  if (/GARBAGE_COLLECTED|garbage collected|UNAVAILABLE_SHARD|not available|NOT_SYNCED/i.test(text)) return 'unavailable_block';
  if (/UNKNOWN_BLOCK|DB Not Found|Block not found/i.test(text)) return 'unknown_block';
  return 'other';
}
