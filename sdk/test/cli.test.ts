import { KeyPair } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXIT, ledgerUrl, main } from '../src/cli.ts';
import { FakeRpc } from './helpers/fake-rpc.ts';

let rpc: FakeRpc;
let out: string[];
let err: string[];
const agentKey = KeyPair.fromRandom('ed25519');

beforeEach(() => {
  rpc = new FakeRpc();
  rpc.install();
  out = [];
  err = [];
});
afterEach(() => vi.unstubAllGlobals());

function run(argv: string[], env: Record<string, string> = {}) {
  return main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env: { ALLOWANCE_VAULT: 'vault.test', ALLOWANCE_RPC_URL: rpc.url, ...env } });
}

const withKey = { ALLOWANCE_AGENT_KEY: agentKey.toString() };

describe('allowance CLI', () => {
  it('prints usage', async () => {
    expect(await run(['--help'])).toBe(EXIT.ok);
    expect(out.join('\n')).toContain('allowance <command>');
    expect(await run([])).toBe(EXIT.error);
  });

  it('reports configuration problems clearly', async () => {
    expect(await main(['receipts'], { out: () => {}, err: (l) => err.push(l), env: {} })).toBe(EXIT.error);
    expect(err[0]).toMatch(/missing --vault/);
    expect(await run(['pay', '--payee', 'api.test', '--amount', '1'])).toBe(EXIT.error);
    expect(err[1]).toMatch(/ALLOWANCE_AGENT_KEY or pass --key-file/);
    expect(await run(['frobnicate'])).toBe(EXIT.error);
  });

  it('simulate exits 3 on block, 2 on needs_approval', async () => {
    let verdict = 'block';
    rpc.view('simulate', () => ({ verdict, reason: verdict === 'block' ? { code: 'not_allowlisted', payee: 'evil.test' } : null, remaining_budget: null }));
    expect(await run(['simulate', '--payee', 'evil.test', '--amount', '2'], withKey)).toBe(EXIT.refused);
    expect(out.at(-1)).toBe('simulate pay 2 NEAR -> evil.test: BLOCK (payee evil.test is not on the allowlist)');
    verdict = 'needs_approval';
    expect(await run(['simulate', '--payee', 'api.test', '--amount', '0.8', '--agent', 'ed25519:abc'])).toBe(EXIT.needsApproval);
    expect(rpc.viewCalls.at(-1)?.args['agent_id']).toEqual({ key: 'ed25519:abc' });
  });

  it('pay refuses to sign what simulate blocks, unless --force', async () => {
    rpc.view('simulate', () => ({ verdict: 'block', reason: { code: 'not_allowlisted', payee: 'evil.test' }, remaining_budget: null }));
    rpc.onTx = () => ({ value: { outcome: 'rejected', receipt_id: 4, reason: { code: 'not_allowlisted', payee: 'evil.test' } } });
    expect(await run(['pay', '--payee', 'evil.test', '--amount', '2'], withKey)).toBe(EXIT.refused);
    expect(rpc.sent).toHaveLength(0);
    expect(out.join('\n')).toContain('REFUSED before signing');
    expect(await run(['pay', '--payee', 'evil.test', '--amount', '2', '--force'], withKey)).toBe(EXIT.refused);
    expect(rpc.sent).toHaveLength(1);
    expect(out.join('\n')).toContain('rejected (receipt #4)');
  });

  it('pay binds the request hash from --nonce', async () => {
    rpc.view('simulate', () => ({ verdict: 'allow', reason: null, remaining_budget: '1' }));
    rpc.onTx = () => ({ value: { outcome: 'paid', receipt_id: 1 } });
    expect(await run(['pay', '--payee', 'api.test', '--amount', '0.02', '--nonce', 'abc', '--json'], withKey)).toBe(EXIT.ok);
    expect(rpc.sent[0]?.args['request_hash']).toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
    expect(JSON.parse(out.join('\n'))).toMatchObject({ outcome: { outcome: 'paid', receipt_id: 1 } });
  });

  it('receipts prints a table', async () => {
    rpc.view('get_vault', () => ({ first_receipt_id: 0, next_receipt_id: 1 }));
    rpc.view('get_receipts', () => [
      { id: 0, kind: 'pay', status: { status: 'rejected', reason: { code: 'not_allowlisted', payee: 'evil.test' } }, agent: { key: 'ed25519:9uk3f895LsBuhPCgWF5pNHfMvfMtE3BVcLioD31UaamR' }, payee: 'evil.test', amount: '2000000000000000000000000', memo: '', delivered: null },
    ]);
    expect(await run(['receipts'])).toBe(EXIT.ok);
    expect(out.join('\n')).toMatch(/#0\s+pay\s+rejected \(not_allowlisted\)\s+ed25519:9uk3f8\.\.\.UaamR\s+evil\.test\s+2 NEAR/);
  });

  it('fits the receipts table to the terminal width by cutting the memo', async () => {
    rpc.view('get_vault', () => ({ first_receipt_id: 12, next_receipt_id: 13 }));
    rpc.view('get_receipts', () => [
      { id: 12, kind: 'pay', status: { status: 'paid' }, agent: { key: 'ed25519:9uk3f895LsBuhPCgWF5pNHfMvfMtE3BVcLioD31UaamR' }, payee: 'api.test', amount: '20000000000000000000000', memo: 'daily candles for the NEAR/USDC report | /dataset', delivered: true },
    ]);
    expect(await main(['receipts'], { out: (l) => out.push(l), err: (l) => err.push(l), env: { ALLOWANCE_VAULT: 'vault.test', ALLOWANCE_RPC_URL: rpc.url }, columns: 100 })).toBe(EXIT.ok);
    const lines = out.join('\n').split('\n');
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(100);
    expect(lines[2]).toMatch(/#12\s+pay\s+paid\s+ed25519:9uk3f8\.\.\.UaamR\s+api\.test\s+0\.02 NEAR\s+pass\s+daily candles.*~$/);
    out.length = 0;
    expect(await run(['receipts'])).toBe(EXIT.ok);
    expect(out.join('\n')).toContain('daily candles for the NEAR/USDC report ~');
  });

  it('owner commands need the owner account and key', async () => {
    expect(await run(['approve', '0'], { ALLOWANCE_OWNER_KEY: agentKey.toString() })).toBe(EXIT.error);
    expect(err.at(-1)).toMatch(/--owner/);
    rpc.onTx = () => ({ value: { outcome: 'paid', receipt_id: 3 } });
    expect(await run(['approve', '0', '--owner', 'owner.test'], { ALLOWANCE_OWNER_KEY: agentKey.toString() })).toBe(EXIT.ok);
    expect(rpc.sent[0]).toMatchObject({ signerId: 'owner.test', methodName: 'approve', args: { pending_id: 0 } });
  });

  it('builds a file:// ledger URL', () => {
    expect(ledgerUrl('http://127.0.0.1:3030', 'vault.test')).toMatch(/^file:\/\/.*\/ledger\/index\.html\?rpc=http%3A%2F%2F127\.0\.0\.1%3A3030&vault=vault\.test$/);
  });
});
