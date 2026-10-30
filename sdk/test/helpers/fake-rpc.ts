/**
 * A fake NEAR JSON-RPC node for unit tests: near-api-js talks to it through
 * a stubbed global `fetch`, so the SDK's real transport code (request
 * encoding, signing, outcome parsing) runs without a chain.
 */
import { baseEncode, decodeSignedTransaction } from 'near-api-js';
import { vi } from 'vitest';

export interface SentTx {
  signerId: string;
  receiverId: string;
  publicKey: string;
  methodName: string;
  args: Record<string, unknown>;
  deposit: bigint;
  gas: bigint;
}

export interface TxReply {
  value?: unknown;
  logs?: string[];
  /** Make send_tx fail with this JSON-RPC error object instead. */
  rpcError?: unknown;
  /** Make the execution fail with this ActionError kind. */
  failure?: unknown;
}

type ViewHandler = (args: Record<string, unknown>, accountId: string) => unknown;
type TxHandler = (tx: SentTx) => TxReply;

export class FakeRpc {
  readonly url = 'http://fake-rpc.test';
  readonly views = new Map<string, ViewHandler>();
  readonly viewCalls: Array<{ accountId: string; method: string; args: Record<string, unknown>; finality?: string; blockId?: string }> = [];
  readonly sent: SentTx[] = [];
  readonly calls: string[] = [];
  onTx: TxHandler = () => ({ value: null });
  codeHash = '11111111111111111111111111111111';
  blockHash = baseEncode(new Uint8Array(32).fill(7));
  height = 100;
  extra: Record<string, (params: Record<string, unknown>) => unknown> = {};
  #nonce = 1;

  view(method: string, handler: ViewHandler): this {
    this.views.set(method, handler);
    return this;
  }

  install(): void {
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const req = JSON.parse(init.body) as { id: unknown; method: string; params: Record<string, unknown> };
      this.calls.push(req.method);
      try {
        const result = this.#dispatch(req.method, req.params);
        return json({ jsonrpc: '2.0', id: req.id, result });
      } catch (err) {
        if (err instanceof RpcFailure) return json({ jsonrpc: '2.0', id: req.id, error: err.payload });
        throw err;
      }
    });
  }

  #dispatch(method: string, params: Record<string, unknown>): unknown {
    const extra = this.extra[method];
    if (extra) return extra(params);
    switch (method) {
      case 'query':
        return this.#query(params);
      case 'block':
        return { header: { hash: this.blockHash, height: this.height }, chunks: [] };
      case 'send_tx':
        return this.#sendTx(params);
      default:
        throw new Error(`fake rpc: unexpected method ${method}`);
    }
  }

  #query(params: Record<string, unknown>): unknown {
    const meta = { block_hash: this.blockHash, block_height: this.height };
    switch (params['request_type']) {
      case 'view_access_key':
        return { ...meta, nonce: 10, permission: 'FullAccess' };
      case 'view_account':
        return { ...meta, amount: '1000', locked: '0', code_hash: this.codeHash, storage_usage: 100 };
      case 'call_function': {
        const method = String(params['method_name']);
        const accountId = String(params['account_id']);
        const args = JSON.parse(Buffer.from(String(params['args_base64']), 'base64').toString('utf8') || '{}') as Record<string, unknown>;
        this.viewCalls.push({
          accountId,
          method,
          args,
          ...(typeof params['finality'] === 'string' ? { finality: params['finality'] } : {}),
          ...(typeof params['block_id'] === 'string' ? { blockId: params['block_id'] } : {}),
        });
        const handler = this.views.get(method);
        if (!handler) throw new Error(`fake rpc: no view handler for ${method}`);
        const value = handler(args, accountId);
        return { ...meta, logs: [], result: [...Buffer.from(value === undefined ? '' : JSON.stringify(value))] };
      }
      default:
        throw new Error(`fake rpc: unexpected query ${String(params['request_type'])}`);
    }
  }

  #sendTx(params: Record<string, unknown>): unknown {
    const signed = decodeSignedTransaction(Buffer.from(String(params['signed_tx_base64']), 'base64'));
    const action = signed.transaction.actions[0] as unknown as { functionCall: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint } };
    const tx: SentTx = {
      signerId: signed.transaction.signerId,
      receiverId: signed.transaction.receiverId,
      publicKey: signed.transaction.publicKey.toString(),
      methodName: action.functionCall.methodName,
      args: JSON.parse(Buffer.from(action.functionCall.args).toString('utf8')) as Record<string, unknown>,
      deposit: BigInt(action.functionCall.deposit),
      gas: BigInt(action.functionCall.gas),
    };
    this.sent.push(tx);
    const reply = this.onTx(tx);
    if (reply.rpcError) throw new RpcFailure(reply.rpcError);
    const id = baseEncode(new Uint8Array(32).fill(this.#nonce++));
    const outcome = (logs: string[]) => ({
      logs,
      receipt_ids: [],
      gas_burnt: 1,
      tokens_burnt: '1',
      executor_id: tx.receiverId,
      status: { SuccessValue: '' },
    });
    const status = reply.failure
      ? { Failure: reply.failure }
      : { SuccessValue: reply.value === undefined || reply.value === null ? '' : Buffer.from(JSON.stringify(reply.value)).toString('base64') };
    return {
      final_execution_status: 'EXECUTED_OPTIMISTIC',
      status,
      transaction: { hash: id, signer_id: tx.signerId, receiver_id: tx.receiverId },
      transaction_outcome: { id, block_hash: this.blockHash, outcome: outcome([]), proof: [] },
      receipts_outcome: [{ id: baseEncode(new Uint8Array(32).fill(200)), block_hash: this.blockHash, outcome: outcome(reply.logs ?? []), proof: [] }],
    };
  }
}

class RpcFailure extends Error {
  readonly payload: unknown;
  constructor(payload: unknown) {
    super('rpc failure');
    this.payload = payload;
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

export function eventLog(event: string, data: Record<string, unknown>): string {
  return `EVENT_JSON:${JSON.stringify({ standard: 'allowance', version: '1.0.0', event, data })}`;
}
