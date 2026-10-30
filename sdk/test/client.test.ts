import { KeyPair, type KeyPairString } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatAmount } from '../src/asset.ts';
import { AllowanceClient } from '../src/client.ts';
import { DEFAULT_GAS, FT_PAY_GAS } from '../src/transport.ts';
import { AllowanceError, toAllowanceError } from '../src/errors.ts';
import { requestHash } from '../src/hash.ts';
import { OwnerClient } from '../src/owner.ts';
import { parseNear } from '../src/units.ts';
import { FakeRpc, eventLog } from './helpers/fake-rpc.ts';

const agentKey = KeyPair.fromRandom('ed25519');
const agentPk = agentKey.getPublicKey().toString();
let rpc: FakeRpc;

beforeEach(() => {
  rpc = new FakeRpc();
  rpc.install();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function agentClient(): AllowanceClient {
  return new AllowanceClient({ vaultId: 'vault.test', rpcUrl: rpc.url, agentKey: agentKey.toString() as KeyPairString });
}

describe('AllowanceClient (agent side, over a mocked JSON-RPC node)', () => {
  it('derives its agent id from the key', () => {
    expect(agentClient().agentId).toEqual({ key: agentPk });
    expect(new AllowanceClient({ vaultId: 'vault.test', rpcUrl: rpc.url }).agentId).toBeUndefined();
  });

  it('simulate is a free view with the agent id, payee and yocto amount', async () => {
    rpc.view('simulate', () => ({ verdict: 'block', reason: { code: 'not_allowlisted', payee: 'attacker.test' } }));
    const sim = await agentClient().simulate('attacker.test', parseNear('2'));
    expect(sim.verdict).toBe('block');
    expect(rpc.viewCalls[0]).toMatchObject({
      accountId: 'vault.test',
      method: 'simulate',
      args: { agent_id: { key: agentPk }, payee: 'attacker.test', amount: '2000000000000000000000000' },
      finality: 'optimistic',
    });
    expect(rpc.sent).toHaveLength(0);
  });

  it('pay signs AS THE VAULT with the function-call key, attaches no deposit, and parses the outcome and events', async () => {
    rpc.onTx = () => ({
      value: { outcome: 'paid', receipt_id: 7 },
      logs: [eventLog('payment_paid', { receipt_id: 7, payee: 'api.test', amount: '20000000000000000000000' })],
    });
    const hash = requestHash('nonce-1');
    const res = await agentClient().pay({ payee: 'api.test', amount: parseNear('0.02'), memo: 'dataset', requestHash: hash });
    expect(res.outcome).toEqual({ outcome: 'paid', receipt_id: 7 });
    expect(res.events.map((e) => e.event)).toEqual(['payment_paid']);
    expect(res.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    const tx = rpc.sent[0]!;
    expect(tx).toMatchObject({ signerId: 'vault.test', receiverId: 'vault.test', publicKey: agentPk, methodName: 'pay', deposit: 0n });
    expect(tx.args).toEqual({ payee: 'api.test', amount: '20000000000000000000000', memo: 'dataset', request_hash: hash });
  });

  it('returns policy rejections as values, not errors', async () => {
    rpc.onTx = () => ({ value: { outcome: 'rejected', receipt_id: 8, reason: { code: 'over_per_tx_cap', cap: '1' } } });
    const res = await agentClient().pay({ payee: 'api.test', amount: 5n });
    expect(res.outcome.outcome).toBe('rejected');
  });

  it('validates inputs before signing anything', async () => {
    const client = agentClient();
    await expect(client.pay({ payee: 'Not Valid', amount: 1n })).rejects.toThrow(/account id/);
    await expect(client.pay({ payee: 'api.test', amount: 0n })).rejects.toThrow(/> 0/);
    await expect(client.pay({ payee: 'api.test', amount: 1n, memo: 'x'.repeat(257) })).rejects.toThrow(/memo/);
    await expect(client.pay({ payee: 'api.test', amount: 1n, requestHash: 'short' })).rejects.toThrow(/32 bytes/);
    expect(rpc.sent).toHaveLength(0);
  });

  it('a read-only client refuses to sign', async () => {
    const reader = new AllowanceClient({ vaultId: 'vault.test', rpcUrl: rpc.url });
    await expect(reader.pay({ payee: 'api.test', amount: 1n })).rejects.toMatchObject({ code: 'config' });
  });

  it('confirm_delivery and ping are signed by the agent key too', async () => {
    rpc.onTx = (tx) => ({ value: tx.methodName === 'ping' ? { agent: { key: agentPk }, registered: true, label: 'worker', active: true, paused: false, block_timestamp_ns: '1' } : null });
    const client = agentClient();
    await client.confirmDelivery(7, true);
    const ping = await client.ping();
    expect(ping.registered).toBe(true);
    expect(rpc.sent.map((t) => [t.methodName, t.args])).toEqual([['confirm_delivery', { receipt_id: 7, passed: true }], ['ping', {}]]);
  });

  it('receipts() pages through every stored receipt', async () => {
    rpc.view('get_vault', () => ({ first_receipt_id: 3, next_receipt_id: 120 }));
    rpc.view('get_receipts', (args) => {
      const from = Number(args['from_id']);
      const to = Math.min(from + Number(args['limit']), 120);
      return Array.from({ length: to - from }, (_, i) => ({ id: from + i }));
    });
    const list = await new AllowanceClient({ vaultId: 'vault.test', rpcUrl: rpc.url }).receipts();
    expect(list.map((r) => r.id)).toEqual(Array.from({ length: 117 }, (_, i) => i + 3));
    expect(rpc.viewCalls.filter((c) => c.method === 'get_receipts').map((c) => c.args['from_id'])).toEqual([3, 53, 103]);
  });

  it('verifyReceipt passes payee, min amount and request hash', async () => {
    rpc.view('verify_receipt', (args) => args['receipt_id'] === 7);
    const reader = new AllowanceClient({ vaultId: 'vault.test', rpcUrl: rpc.url });
    expect(await reader.verifyReceipt({ receiptId: 7, payee: 'api.test', minAmount: '5', requestHash: requestHash('n') })).toBe(true);
    expect(await reader.verifyReceipt({ receiptId: 8, payee: 'api.test', minAmount: 5n })).toBe(false);
    expect(rpc.viewCalls[0]?.args).toEqual({ receipt_id: 7, payee: 'api.test', min_amount: '5', request_hash: requestHash('n') });
  });

  it('waitForSettlement polls until the receipt leaves pending', async () => {
    const states = ['pending', 'approved', 'paid'];
    rpc.view('get_receipt', () => ({ id: 3, status: { status: states.shift() ?? 'paid' } }));
    const seen: string[] = [];
    const r = await new AllowanceClient({ vaultId: 'vault.test', rpcUrl: rpc.url }).waitForSettlement(3, {
      intervalMs: 1,
      onPoll: (x) => seen.push(x.status.status),
    });
    expect(r.status.status).toBe('paid');
    expect(seen).toEqual(['pending', 'approved', 'paid']);
  });

  it('NEP-141: simulate, pay and verify carry the asset; pay gets the token gas budget', async () => {
    const usd = { ft: 'usd.test' } as const;
    rpc.view('simulate', () => ({ verdict: 'allow', reason: null }));
    rpc.view('verify_receipt', () => true);
    rpc.onTx = () => ({ value: { outcome: 'failed', receipt_id: 9, reason: 'payee_not_registered' } });
    const client = agentClient();
    await client.simulate('api.test', 2_000_000n, { asset: usd });
    expect(rpc.viewCalls[0]?.args).toMatchObject({ asset: usd, amount: '2000000' });
    const res = await client.pay({ payee: 'api.test', amount: 2_000_000n, asset: usd });
    expect(res.outcome).toEqual({ outcome: 'failed', receipt_id: 9, reason: 'payee_not_registered' });
    expect(rpc.sent[0]?.args).toEqual({ payee: 'api.test', amount: '2000000', asset: usd });
    expect(rpc.sent[0]?.gas).toBe(FT_PAY_GAS);
    expect(await client.verifyReceipt({ receiptId: 9, payee: 'api.test', minAmount: 2_000_000n, asset: usd })).toBe(true);
    expect(rpc.viewCalls[1]?.args).toMatchObject({ asset: usd });
    // NEAR stays the contract's default: no asset argument, default gas.
    await client.pay({ payee: 'api.test', amount: 1n });
    expect(rpc.sent[1]?.args).not.toHaveProperty('asset');
    expect(rpc.sent[1]?.gas).toBe(DEFAULT_GAS);
  });

  it('reads token metadata from the token contract and learns how to show it', async () => {
    rpc.view('ft_metadata', (_args, accountId) => ({ spec: 'ft-1.0.0', name: 'x', symbol: accountId === 'usd.test' ? 'SUSD' : '?', decimals: 6 }));
    const meta = await agentClient().ftMetadata('usd.test');
    expect(meta.symbol).toBe('SUSD');
    expect(rpc.viewCalls[0]).toMatchObject({ accountId: 'usd.test', method: 'ft_metadata' });
    expect(formatAmount('1500000', { ft: 'usd.test' })).toBe('1.5 SUSD');
  });

  it('waitForSettlement times out', async () => {
    rpc.view('get_receipt', () => ({ id: 3, status: { status: 'pending' } }));
    await expect(new AllowanceClient({ vaultId: 'vault.test', rpcUrl: rpc.url }).waitForSettlement(3, { timeoutMs: 5, intervalMs: 2 })).rejects.toThrow(/still pending/);
  });
});

describe('OwnerClient', () => {
  it('signs from the owner account, attaches the deposit for deposit()', async () => {
    const ownerKey = KeyPair.fromRandom('ed25519');
    rpc.onTx = (tx) => ({ value: tx.methodName === 'deposit' ? 0 : { outcome: 'paid', receipt_id: 3 } });
    const owner = new OwnerClient({ vaultId: 'vault.test', ownerId: 'owner.test', rpcUrl: rpc.url, ownerKey: ownerKey.toString() as KeyPairString });
    await owner.deposit(parseNear('5'));
    const approved = await owner.approve(0);
    expect(approved.value).toEqual({ outcome: 'paid', receipt_id: 3 });
    expect(rpc.sent.map((t) => [t.signerId, t.receiverId, t.methodName, t.deposit])).toEqual([
      ['owner.test', 'vault.test', 'deposit', parseNear('5')],
      ['owner.test', 'vault.test', 'approve', 0n],
    ]);
    expect(rpc.sent[1]?.gas).toBe(FT_PAY_GAS);
  });

  it('registers tokens (attaching the vault storage) and withdraws them', async () => {
    const ownerKey = KeyPair.fromRandom('ed25519');
    rpc.onTx = () => ({ value: null });
    const owner = new OwnerClient({ vaultId: 'vault.test', ownerId: 'owner.test', rpcUrl: rpc.url, ownerKey: ownerKey.toString() as KeyPairString });
    await owner.registerToken('usd.test', { minDeposit: 1000n, attachYocto: parseNear('0.01') });
    await owner.withdrawFt('usd.test', 5_000_000n, 'cold.test');
    expect(rpc.sent.map((t) => [t.methodName, t.args, t.deposit])).toEqual([
      ['register_token', { token_id: 'usd.test', min_deposit: '1000' }, parseNear('0.01')],
      ['withdraw_ft', { token_id: 'usd.test', amount: '5000000', to: 'cold.test' }, 0n],
    ]);
  });
});

describe('error mapping', () => {
  const named = (name: string, message: string) => Object.assign(new Error(message), { name, txHash: 'abc' });

  it('maps protocol refusals of the function-call key to stable codes', () => {
    expect(toAllowanceError(named('AccessKeyNotFoundActionError', 'Access key ed25519:x does not exist on account vault.test')).code).toBe('access_key_not_found');
    expect(toAllowanceError(named('AccessKeyMethodNameMismatchActionError', 'Access key does not allow method withdraw')).code).toBe('method_not_allowed');
    expect(toAllowanceError(named('X', 'DepositWithFunctionCall')).code).toBe('deposit_not_allowed');
    expect(toAllowanceError(named('X', 'NotEnoughAllowance')).code).toBe('not_enough_allowance');
    const panic = toAllowanceError(named('ContractExecutionError', 'Smart contract panicked: unknown agent'));
    expect(panic).toBeInstanceOf(AllowanceError);
    expect(panic.code).toBe('contract_panic');
    expect(panic.txHash).toBe('abc');
    expect(toAllowanceError(new TypeError('fetch failed')).code).toBe('rpc');
  });
});
