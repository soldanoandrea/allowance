import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../../sdk/src/sandbox.ts';
import { readConfig } from './config.ts';

// Placeholder files: readConfig only checks that the paths exist.
const dir = mkdtempSync(join(tmpdir(), 'allowance-testnet-config-'));
const placeholder = (name: string): string => {
  const path = join(dir, name);
  writeFileSync(path, 'placeholder, not a key\n');
  return path;
};
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const valid = (): Record<string, string> => ({
  TESTNET_OWNER_ID: 'you.testnet',
  TESTNET_OWNER_KEY_FILE: placeholder('owner.json'),
  TESTNET_VAULT_ID: 'vault.you.testnet',
  TESTNET_VAULT_KEY_FILE: placeholder('vault.json'),
  TESTNET_PAYEE_ID: 'api.you.testnet',
  TESTNET_AGENT_KEY_FILE: placeholder('agent.json'),
});

describe('testnet demo configuration (nothing is sent)', () => {
  it('accepts a complete testnet configuration, dry run by default', () => {
    const { config, problems } = readConfig(valid());
    expect(problems).toEqual([]);
    expect(config).toMatchObject({ rpcUrl: 'https://test.rpc.fastnear.com', vaultId: 'vault.you.testnet', confirmed: false, autoApprove: false });
    expect(readConfig({ ...valid(), TESTNET_CONFIRM: 'yes' }).config?.confirmed).toBe(true);
    expect(readConfig(valid(), ['--yes']).config?.confirmed).toBe(true);
  });

  it('refuses mainnet endpoints and non-testnet accounts', () => {
    expect(readConfig({ ...valid(), TESTNET_RPC_URL: 'https://rpc.mainnet.fastnear.com' }).problems.join()).toMatch(/mainnet/);
    expect(readConfig({ ...valid(), TESTNET_OWNER_ID: 'you.near' }).problems.join()).toMatch(/only \*\.testnet/);
    expect(readConfig({ ...valid(), TESTNET_RPC_URL: 'https://rpc.example.com' }).problems.join()).toMatch(/does not look like a testnet/);
  });

  it('lists every missing variable and file', () => {
    const { config, problems } = readConfig({ TESTNET_AGENT_KEY_FILE: '/nonexistent/agent.json' });
    expect(config).toBeNull();
    expect(problems).toEqual(
      expect.arrayContaining(['TESTNET_OWNER_ID is not set', 'TESTNET_VAULT_KEY or TESTNET_VAULT_KEY_FILE is not set', 'TESTNET_AGENT_KEY_FILE=/nonexistent/agent.json: file not found']),
    );
    // A key in the environment (e.g. injected by a password manager) replaces the file.
    const fromEnv = { ...valid(), TESTNET_OWNER_KEY_FILE: '', TESTNET_OWNER_KEY: 'ed25519:injected' };
    expect(readConfig(fromEnv).config?.ownerKeyFile).toBeNull();
    expect(readConfig({ ...valid(), TESTNET_APPROVAL_THRESHOLD: '1' }).problems.join()).toMatch(/below TESTNET_PER_TX_CAP/);
  });

  it('TESTNET_CREATE_ACCOUNTS=1: one owner account and its key are enough', () => {
    const { config, problems } = readConfig({ TESTNET_CREATE_ACCOUNTS: '1', TESTNET_OWNER_ID: 'you.testnet', TESTNET_OWNER_KEY: 'ed25519:injected' });
    expect(problems).toEqual([]);
    expect(config).toMatchObject({
      vaultId: 'vault.you.testnet',
      payeeId: 'api.you.testnet',
      attackerId: 'attacker.you.testnet',
      vaultKeyFile: null,
      agentKeyFile: null,
      createAccounts: true,
      ephemeralAgent: true,
    });
    const elsewhere = readConfig({ TESTNET_CREATE_ACCOUNTS: '1', TESTNET_OWNER_ID: 'you.testnet', TESTNET_OWNER_KEY: 'ed25519:x', TESTNET_PAYEE_ID: 'api.other.testnet' });
    expect(elsewhere.problems.join()).toMatch(/must be a sub-account of you\.testnet/);
    expect(readConfig(valid()).config).toMatchObject({ createAccounts: false, ephemeralAgent: false, attackerId: null });
  });

  it('the script stops after printing the plan unless confirmed', () => {
    const out = execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'testnet', 'demo.ts'), 'all'], {
      // An unroutable RPC: any network access in dry-run mode would fail the run.
      env: { ...process.env, ...valid(), TESTNET_RPC_URL: 'http://127.0.0.1:9/testnet', TESTNET_CONFIRM: '' },
      encoding: 'utf8',
    });
    expect(out).toContain('vault vault.you.testnet');
    expect(out).toContain('dry run: nothing was sent');
    const one = execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'testnet', 'demo.ts'), 'all'], {
      env: { ...process.env, TESTNET_CREATE_ACCOUNTS: '1', TESTNET_OWNER_ID: 'you.testnet', TESTNET_OWNER_KEY: 'ed25519:placeholder', TESTNET_RPC_URL: 'http://127.0.0.1:9/testnet', TESTNET_CONFIRM: '' },
      encoding: 'utf8',
    });
    expect(one).toContain('you.testnet creates vault.you.testnet, api.you.testnet, attacker.you.testnet if missing');
    expect(one).toContain('agent key from memory (generated for this run)');
    expect(one).toContain('dry run: nothing was sent');
  });
});
