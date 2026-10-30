import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KeyPair } from 'near-api-js';
import { describe, expect, it } from 'vitest';

import { AllowanceError } from '../src/errors.ts';
import { AGENT_KEY_ENV, loadKey } from '../src/keys.ts';

const kp = KeyPair.fromRandom('ed25519');
const secret = kp.toString();
const pub = kp.getPublicKey().toString();

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'allowance-keys-'));
}

describe('loadKey', () => {
  it('reads the agent key from the environment', () => {
    const key = loadKey({ env: { [AGENT_KEY_ENV]: secret } });
    expect(key.publicKey).toBe(pub);
    expect(key.source).toBe(`env ${AGENT_KEY_ENV}`);
    expect(key.source).not.toContain(secret);
  });

  it('prefers an explicit key file (near-cli JSON) over the environment', () => {
    const dir = tempDir();
    const file = join(dir, 'agent.json');
    writeFileSync(file, JSON.stringify({ account_id: 'vault.test', public_key: pub, private_key: secret }), { mode: 0o600 });
    const other = KeyPair.fromRandom('ed25519').toString();
    const key = loadKey({ keyFile: file, env: { [AGENT_KEY_ENV]: other } });
    expect(key.publicKey).toBe(pub);
    expect(key.warnings).toEqual([]);
  });

  it('accepts a bare "ed25519:..." text file and warns about loose permissions', () => {
    const dir = tempDir();
    const file = join(dir, 'agent.key');
    writeFileSync(file, `${secret}\n`);
    chmodSync(file, 0o644);
    const key = loadKey({ keyFile: file, env: {} });
    expect(key.publicKey).toBe(pub);
    expect(key.warnings[0]).toMatch(/chmod 600/);
  });

  it('rejects a JSON file whose public key does not match', () => {
    const dir = tempDir();
    const file = join(dir, 'agent.json');
    writeFileSync(file, JSON.stringify({ public_key: KeyPair.fromRandom('ed25519').getPublicKey().toString(), private_key: secret }), { mode: 0o600 });
    expect(() => loadKey({ keyFile: file })).toThrow(/does not match/);
  });

  it('fails with a config error when no key is available or the key is malformed', () => {
    expect(() => loadKey({ env: {} })).toThrow(AllowanceError);
    expect(() => loadKey({ env: { [AGENT_KEY_ENV]: 'ed25519:nope' } })).toThrow(/invalid key/);
    expect(() => loadKey({ keyFile: '/definitely/not/here.json' })).toThrow(/cannot read key file/);
  });

  it('never writes anything', () => {
    const dir = tempDir();
    const file = join(dir, 'agent.json');
    writeFileSync(file, JSON.stringify({ private_key: secret }), { mode: 0o600 });
    loadKey({ keyFile: file });
    expect(readdirSync(dir)).toEqual(['agent.json']);
  });
});
