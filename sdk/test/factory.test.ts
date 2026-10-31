import { KeyPair, type KeyPairString } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXIT, main } from '../src/cli.ts';
import { CREATE_VAULT_GAS, FactoryClient, isVaultName, parseFactoryEvents } from '../src/factory.ts';
import { parseNear } from '../src/units.ts';
import { FakeRpc } from './helpers/fake-rpc.ts';

const ownerKey = KeyPair.fromRandom('ed25519');
const HASH = '8cXa3JvW4M7Xh1cH9LbZ1WfH5oUQ1vB2Cq7tYF3o6uYd';
let rpc: FakeRpc;

function factoryEvent(event: string, data: Record<string, unknown>): string {
  return `EVENT_JSON:${JSON.stringify({ standard: 'allowance_factory', version: '1.0.0', event, data })}`;
}

beforeEach(() => {
  rpc = new FakeRpc();
  rpc.install();
  rpc.view('get_info', () => ({ owner_id: 'admin.test', vault_code_hash: HASH, min_deposit: parseNear('0.1').toString(), vaults: 1 }));
  rpc.view('get_vaults', (args) => [
    { vault_id: 'alice.factory.test', owner_id: 'alice.test', code_hash: HASH, created_by: 'alice.test', created_at_ns: '1793318400000000000', ...args },
  ]);
  rpc.view('get_vault', (args) => (args['vault_id'] === 'alice.factory.test' ? { owner_id: 'alice.test', code_hash: HASH, created_by: 'alice.test', created_at_ns: '1' } : null));
});
afterEach(() => vi.unstubAllGlobals());

function signer(id = 'alice.test'): FactoryClient {
  return new FactoryClient({ factoryId: 'factory.test', rpcUrl: rpc.url, signerId: id, signerKey: ownerKey.toString() as KeyPairString });
}

describe('FactoryClient (over a mocked JSON-RPC node)', () => {
  it('createVault signs create_vault on the factory with the deposit and the vault settings', async () => {
    rpc.onTx = () => ({ value: true, logs: [factoryEvent('vault_created', { vault_id: 'bot.factory.test', owner_id: 'bob.test', code_hash: HASH })] });
    const res = await signer().createVault({
      name: 'bot',
      ownerId: 'bob.test',
      approverId: 'dao.test',
      approvalTtlNs: 3_600_000_000_000n,
      keyGasAllowance: parseNear('0.5'),
      deposit: parseNear('2'),
    });
    expect(res).toMatchObject({ vaultId: 'bot.factory.test', created: true, ownerId: 'bob.test', deposit: parseNear('2'), codeHash: HASH });
    expect(res.events.map((e) => e.event)).toEqual(['vault_created']);
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.sent[0]).toMatchObject({
      signerId: 'alice.test',
      receiverId: 'factory.test',
      publicKey: ownerKey.getPublicKey().toString(),
      methodName: 'create_vault',
      deposit: parseNear('2'),
      gas: CREATE_VAULT_GAS,
    });
    expect(rpc.sent[0]?.args).toEqual({
      name: 'bot',
      owner_id: 'bob.test',
      approver_id: 'dao.test',
      approval_ttl_ns: '3600000000000',
      key_gas_allowance: parseNear('0.5').toString(),
    });
  });

  it('defaults: the owner is the signer and the deposit is the factory minimum', async () => {
    rpc.onTx = () => ({ value: true });
    const res = await signer().createVault({ name: 'alice-2' });
    expect(res).toMatchObject({ vaultId: 'alice-2.factory.test', ownerId: 'alice.test', deposit: parseNear('0.1'), created: true });
    expect(rpc.sent[0]?.args).toEqual({ name: 'alice-2', owner_id: 'alice.test' });
    expect(rpc.sent[0]?.deposit).toBe(parseNear('0.1'));
  });

  it('a failed creation is a value: created false, the deposit refunded by the factory', async () => {
    rpc.onTx = () => ({
      value: false,
      logs: [factoryEvent('vault_creation_failed', { vault_id: 'x.factory.test', refunded_to: 'alice.test', amount: parseNear('1').toString() })],
    });
    const res = await signer().createVault({ name: 'x', deposit: parseNear('1') });
    expect(res.created).toBe(false);
    expect(res.codeHash).toBeUndefined();
    expect(res.events.map((e) => e.event)).toEqual(['vault_creation_failed']);
  });

  it('checks the name, the accounts and the deposit before signing anything', async () => {
    const client = signer();
    await expect(client.createVault({ name: 'a.b' })).rejects.toMatchObject({ code: 'config' });
    await expect(client.createVault({ name: 'Alice' })).rejects.toThrow(/one label/);
    await expect(client.createVault({ name: '-x' })).rejects.toThrow(/one label/);
    await expect(client.createVault({ name: 'x'.repeat(33) })).rejects.toThrow(/one label/);
    await expect(client.createVault({ name: 'ok', ownerId: 'Not Valid' })).rejects.toThrow(/owner/);
    await expect(client.createVault({ name: 'ok', approvalTtlNs: 0n })).rejects.toThrow(/TTL/);
    await expect(client.createVault({ name: 'ok', deposit: parseNear('0.05') })).rejects.toThrow(/below the factory's minimum/);
    expect(rpc.sent).toHaveLength(0);
    expect(isVaultName('a')).toBe(true);
    expect(isVaultName('team_bot-7')).toBe(true);
    expect(isVaultName('x'.repeat(32))).toBe(true);
    expect(isVaultName('bot_')).toBe(false);
  });

  it('a read-only client lists vaults but refuses to sign', async () => {
    const reader = new FactoryClient({ factoryId: 'factory.test', rpcUrl: rpc.url });
    expect((await reader.info()).vaults).toBe(1);
    const list = await reader.vaults({ fromIndex: 0, limit: 10 });
    expect(list[0]).toMatchObject({ vault_id: 'alice.factory.test', owner_id: 'alice.test' });
    expect(rpc.viewCalls.at(-1)).toMatchObject({ accountId: 'factory.test', method: 'get_vaults', args: { from_index: 0, limit: 10 } });
    expect(await reader.vault('alice.factory.test')).toMatchObject({ owner_id: 'alice.test' });
    expect(await reader.vault('nobody.factory.test')).toBeNull();
    await expect(reader.createVault({ name: 'bot' })).rejects.toMatchObject({ code: 'config' });
    expect(() => new FactoryClient({ factoryId: 'factory.test', rpcUrl: rpc.url, signerKey: ownerKey.toString() as KeyPairString })).toThrow(/signerId/);
    expect(rpc.sent).toHaveLength(0);
  });

  it('parses only factory events', () => {
    const logs = [
      'plain log line',
      factoryEvent('vault_created', { vault_id: 'a.f.test' }),
      `EVENT_JSON:${JSON.stringify({ standard: 'allowance', version: '1.0.0', event: 'vault_funded', data: {} })}`,
      'EVENT_JSON:{not json',
    ];
    expect(parseFactoryEvents(logs).map((e) => e.event)).toEqual(['vault_created']);
  });
});

describe('allowance factory (CLI)', () => {
  let out: string[];
  let err: string[];
  beforeEach(() => {
    out = [];
    err = [];
  });
  const run = (argv: string[], env: Record<string, string> = {}) =>
    main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env: { ALLOWANCE_FACTORY: 'factory.test', ALLOWANCE_RPC_URL: rpc.url, ...env } });
  const withKey = { ALLOWANCE_OWNER_KEY: ownerKey.toString() };

  it('factory create signs as --owner and prints the new vault', async () => {
    rpc.onTx = () => ({ value: true, logs: [factoryEvent('vault_created', { vault_id: 'shop.factory.test', owner_id: 'shop.test', code_hash: HASH })] });
    const code = await run(['factory', 'create', '--name', 'shop', '--owner', 'shop.test', '--deposit', '1.5', '--approver', 'ops.test', '--approval-ttl', '2h'], withKey);
    expect(code).toBe(EXIT.ok);
    expect(rpc.sent[0]).toMatchObject({ signerId: 'shop.test', receiverId: 'factory.test', methodName: 'create_vault', deposit: parseNear('1.5') });
    expect(rpc.sent[0]?.args).toMatchObject({ name: 'shop', owner_id: 'shop.test', approver_id: 'ops.test', approval_ttl_ns: '7200000000000' });
    expect(out.join('\n')).toContain(`created vault shop.factory.test: owner shop.test, balance 1.5 NEAR, code ${HASH}`);
  });

  it('factory create with --signer creates a vault for another owner; --json is machine-readable', async () => {
    rpc.onTx = () => ({ value: true });
    expect(await run(['factory', 'create', '--name', 'client', '--owner', 'client.test', '--signer', 'platform.test', '--json'], withKey)).toBe(EXIT.ok);
    expect(rpc.sent[0]).toMatchObject({ signerId: 'platform.test', args: { owner_id: 'client.test' } });
    expect(JSON.parse(out.join('\n'))).toMatchObject({ vaultId: 'client.factory.test', created: true, deposit: parseNear('0.1').toString() });
  });

  it('factory create exits 1 when the creation fails, and needs a name, a signer and a key', async () => {
    rpc.onTx = () => ({ value: false });
    expect(await run(['factory', 'create', '--name', 'taken', '--owner', 'alice.test'], withKey)).toBe(EXIT.error);
    expect(out.at(-1)).toMatch(/was NOT created; the factory refunded 0.1 NEAR to alice.test/);
    expect(await run(['factory', 'create', '--owner', 'alice.test'], withKey)).toBe(EXIT.error);
    expect(err.at(-1)).toMatch(/missing --name/);
    expect(await run(['factory', 'create', '--name', 'x'], withKey)).toBe(EXIT.error);
    expect(err.at(-1)).toMatch(/missing --owner or --signer/);
    expect(await run(['factory', 'create', '--name', 'x', '--owner', 'alice.test'])).toBe(EXIT.error);
    expect(err.at(-1)).toMatch(/ALLOWANCE_OWNER_KEY/);
    expect(await main(['factory', 'list'], { out: () => {}, err: (l) => err.push(l), env: { ALLOWANCE_RPC_URL: rpc.url } })).toBe(EXIT.error);
    expect(err.at(-1)).toMatch(/missing --factory/);
    expect(rpc.sent).toHaveLength(1);
  });

  it('factory list prints a table, factory info the factory settings', async () => {
    expect(await run(['factory', 'list', '--limit', '5'])).toBe(EXIT.ok);
    expect(out.join('\n')).toMatch(/alice\.factory\.test\s+alice\.test\s+alice\.test\s+2026-10-30T00:00:00Z\s+8cXa3J\.\.\.o6uYd/);
    expect(rpc.viewCalls.at(-1)?.args).toEqual({ limit: 5 });
    out.length = 0;
    expect(await run(['factory', 'info'])).toBe(EXIT.ok);
    expect(out.join('\n')).toContain('minimum deposit per vault: 0.1 NEAR');
    expect(out.join('\n')).toContain(`vault code (global contract by hash, immutable): ${HASH}`);
    expect(await run(['factory', 'frobnicate'])).toBe(EXIT.error);
    expect(err.at(-1)).toMatch(/use create, list or info/);
  });
});
