/**
 * A tiny in-memory NEAR chain behind a JSON-RPC `fetch`: block headers with
 * timestamps, accounts that appear at a height, code that changes at
 * heights, skipped heights, pruned history, and the vault views the risk
 * check reads. Enough to exercise the binary searches without a node.
 */
export const T0_NS = 1_790_000_000_000_000_000n;

export interface MockAccount {
  createdAt: number;
  /** [height, code hash] in increasing height order; empty = no contract. */
  code?: Array<[number, string]>;
  /** Uses a global contract (by hash, or by publisher account). */
  global?: { hash?: string; account?: string };
}

export class MockChain {
  head = 100_000;
  genesis = 0;
  /** Seconds between blocks. */
  blockSeconds = 10;
  accounts = new Map<string, MockAccount>();
  skipped = new Set<number>();
  /** Heights below this are garbage-collected (a non-archival node). */
  prunedBelow = 0;
  vaultDenylist: string[] = [];
  receipts: unknown[] = [];
  /** JSON-RPC methods / request types served, in order. */
  log: string[] = [];
  /** FastNear transactions API answers, by account. */
  fastnear = new Map<string, { tx_block_height: number; tx_block_timestamp: string }>();
  fail = false;

  ts(height: number): bigint {
    return T0_NS + BigInt(height) * BigInt(this.blockSeconds) * 1_000_000_000n;
  }

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    if (href.endsWith('/v0/account')) {
      const { account_id } = JSON.parse(String(init?.body)) as { account_id: string };
      this.log.push('fastnear');
      const row = this.fastnear.get(account_id);
      return json({ account_txs: row ? [{ account_id, transaction_hash: 'h', tx_index: 0, ...row }] : [], txs_count: row ? 1 : 0 });
    }
    const req = JSON.parse(String(init?.body)) as { id: string; method: string; params: Record<string, unknown> };
    if (this.fail) return json({ jsonrpc: '2.0', id: req.id, error: { name: 'INTERNAL_ERROR', cause: { name: 'INTERNAL_ERROR' } } });
    try {
      return json({ jsonrpc: '2.0', id: req.id, result: this.#dispatch(req.method, req.params) });
    } catch (err) {
      return json({ jsonrpc: '2.0', id: req.id, error: { name: 'HANDLER_ERROR', cause: { name: (err as Error).message } } });
    }
  };

  #height(params: Record<string, unknown>): number {
    if (params['block_id'] === undefined) return this.head;
    const h = Number(params['block_id']);
    if (h > this.head) throw new Error('UNKNOWN_BLOCK');
    if (h < this.prunedBelow) throw new Error('GARBAGE_COLLECTED_BLOCK');
    if (this.skipped.has(h)) throw new Error('UNKNOWN_BLOCK');
    return h;
  }

  #dispatch(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'EXPERIMENTAL_genesis_config':
        this.log.push(method);
        return { genesis_height: this.genesis };
      case 'block': {
        this.log.push('block');
        const h = this.#height(params);
        return { header: { height: h, hash: `hash${h}`, timestamp_nanosec: this.ts(h).toString() }, chunks: [] };
      }
      case 'query': {
        const type = String(params['request_type']);
        this.log.push(type);
        const h = this.#height(params);
        const meta = { block_height: h, block_hash: `hash${h}` };
        if (type === 'view_account') {
          const a = this.accounts.get(String(params['account_id']));
          if (!a || a.createdAt > h) throw new Error('UNKNOWN_ACCOUNT');
          const code = (a.code ?? []).filter(([at]) => at <= h).at(-1)?.[1] ?? '11111111111111111111111111111111';
          const global = a.global?.hash ? { global_contract_hash: a.global.hash } : a.global?.account ? { global_contract_account_id: a.global.account } : {};
          return { ...meta, amount: '1', locked: '0', code_hash: code, storage_usage: 100, storage_paid_at: 0, ...global };
        }
        if (type === 'call_function') {
          const name = String(params['method_name']);
          const args = JSON.parse(Buffer.from(String(params['args_base64']), 'base64').toString() || '{}') as Record<string, number>;
          let value: unknown;
          if (name === 'get_denylist') value = this.vaultDenylist;
          else if (name === 'get_vault') value = { first_receipt_id: 0, next_receipt_id: this.receipts.length, tokens: [] };
          else if (name === 'get_receipts') value = this.receipts.slice(args['from_id'] ?? 0, (args['from_id'] ?? 0) + (args['limit'] ?? 50));
          else throw new Error(`no view ${name}`);
          return { ...meta, logs: [], result: [...Buffer.from(JSON.stringify(value))] };
        }
        throw new Error(`unexpected query ${type}`);
      }
      default:
        throw new Error(`unexpected method ${method}`);
    }
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A receipt as the vault returns it (only the fields the risk check reads matter). */
export function receipt(id: number, payee: string, amount: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id,
    kind: 'pay',
    status: { status: 'paid' },
    agent: { key: 'ed25519:x' },
    payee,
    amount,
    asset: 'near',
    memo: '',
    request_hash: null,
    ts_ns: '0',
    policy_version: 1,
    delivered: null,
    pending_id: null,
    approved_by: null,
    storage_deposit: null,
    split: [],
    ...extra,
  };
}
