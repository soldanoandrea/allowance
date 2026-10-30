import { readFileSync, statSync } from 'node:fs';

import { KeyPair, type KeyPairString } from 'near-api-js';

import { AllowanceError } from './errors.ts';

/** Environment variable holding the agent's function-call key. */
export const AGENT_KEY_ENV = 'ALLOWANCE_AGENT_KEY';
/** Environment variable holding the owner's full-access key (owner commands only). */
export const OWNER_KEY_ENV = 'ALLOWANCE_OWNER_KEY';

export interface LoadedKey {
  secretKey: KeyPairString;
  publicKey: string;
  /** Where it came from, for logs ("env ALLOWANCE_AGENT_KEY", "file ./agent.json"). Never the key. */
  source: string;
  warnings: string[];
}

export interface KeySource {
  /** Path given explicitly by the user (`--key-file`). Takes precedence over the environment. */
  keyFile?: string | undefined;
  envVar?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Load a secret key from an explicit file path or an environment variable.
 * The SDK only ever reads keys; it never writes, caches or logs them.
 *
 * Accepted file formats: a near-cli credentials JSON
 * (`{"account_id", "public_key", "private_key"}`; `secret_key` also accepted)
 * or a text file containing just `ed25519:...`.
 */
export function loadKey(source: KeySource = {}): LoadedKey {
  const envVar = source.envVar ?? AGENT_KEY_ENV;
  const env = source.env ?? process.env;
  if (source.keyFile) return fromFile(source.keyFile);
  const value = env[envVar]?.trim();
  if (value) return finish(value, `env ${envVar}`, []);
  throw new AllowanceError('config', `no key: set ${envVar} or pass --key-file <path>`);
}

function fromFile(path: string): LoadedKey {
  const warnings: string[] = [];
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trim();
    if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
      warnings.push(`key file ${path} is readable by other users; chmod 600 it`);
    }
  } catch (err) {
    throw new AllowanceError('config', `cannot read key file ${path}: ${(err as Error).message}`, { cause: err });
  }
  if (!text.startsWith('{')) return finish(text, `file ${path}`, warnings);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new AllowanceError('config', `key file ${path} is not valid JSON`, { cause: err });
  }
  const secret = json['private_key'] ?? json['secret_key'];
  if (typeof secret !== 'string') {
    throw new AllowanceError('config', `key file ${path} has no "private_key"`);
  }
  const loaded = finish(secret, `file ${path}`, warnings);
  if (typeof json['public_key'] === 'string' && json['public_key'] !== loaded.publicKey) {
    throw new AllowanceError('config', `key file ${path}: public_key does not match private_key`);
  }
  return loaded;
}

function finish(secret: string, source: string, warnings: string[]): LoadedKey {
  let keyPair: KeyPair;
  try {
    keyPair = KeyPair.fromString(secret as KeyPairString);
  } catch (err) {
    throw new AllowanceError('config', `invalid key from ${source} (expected "ed25519:<base58>")`, { cause: err });
  }
  return { secretKey: secret as KeyPairString, publicKey: keyPair.getPublicKey().toString(), source, warnings };
}
