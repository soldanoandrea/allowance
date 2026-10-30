/**
 * Local-sandbox helpers for the demo and the end-to-end test. Nothing here
 * talks to testnet or mainnet: the node is a throw-away `neard-sandbox`
 * hosted by `examples/local_demo/sandbox_node.rs` (near-sandbox crate), and
 * every account lives and dies with it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { Account, JsonRpcProvider, KeyPair, actions, baseEncode, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';

import { setTokenDisplay } from './asset.ts';
import { OwnerClient } from './owner.ts';
import type { Policy } from './types.ts';
import { parseNear, parseUnits } from './units.ts';

/** Repository root (this file is sdk/src/sandbox.ts). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SANDBOX_NODE_BIN = join(REPO_ROOT, 'target', 'debug', 'examples', 'sandbox_node');
export const VAULT_WASM = join(REPO_ROOT, 'target', 'near', 'allowance.wasm');
/** The NEP-141 test token (tests/fixtures/test-token), built by `make build`. */
export const TOKEN_WASM = join(REPO_ROOT, 'target', 'near', 'test_token', 'test_token.wasm');

export interface SandboxNode {
  rpcUrl: string;
  rootAccountId: string;
  /** The sandbox's well-known genesis key: only valid on this local chain. */
  rootSecretKey: KeyPairString;
  stop(): Promise<void>;
}

/** What is missing to run the NEP-141 scenario, or null. */
export function tokenPrerequisites(): string | null {
  return existsSync(TOKEN_WASM) ? null : `${TOKEN_WASM} is missing: run \`make build\``;
}

/** What is missing to run against a sandbox, or null when everything is there. */
export function sandboxPrerequisites(): string | null {
  if (!existsSync(VAULT_WASM)) return `${VAULT_WASM} is missing: run \`make build\``;
  if (!existsSync(SANDBOX_NODE_BIN)) return `${SANDBOX_NODE_BIN} is missing: run \`make sandbox-node\``;
  return null;
}

/**
 * Start `sandbox_node` and wait for its ready line. The first run downloads
 * the neard-sandbox binary (near-sandbox crate), hence the long timeout.
 * Closing the child's stdin stops the node.
 */
export async function startSandboxNode(options: { binPath?: string; timeoutMs?: number; log?: (line: string) => void } = {}): Promise<SandboxNode> {
  const bin = options.binPath ?? SANDBOX_NODE_BIN;
  if (!existsSync(bin)) throw new Error(`${bin} not found: run \`make sandbox-node\` (cargo build --example sandbox_node)`);
  const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr = createInterface({ input: child.stderr! });
  stderr.on('line', (line) => options.log?.(line));
  const lines = createInterface({ input: child.stdout! });
  const ready = await new Promise<{ rpc_url: string; root_account_id: string; root_secret_key: string }>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('sandbox_node did not start in time')), options.timeoutMs ?? 300_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`sandbox_node exited early (code ${code})`));
    });
    lines.once('line', (line) => {
      clearTimeout(timer);
      try {
        resolveReady(JSON.parse(line));
      } catch (err) {
        reject(err as Error);
      }
    });
  });
  return {
    rpcUrl: ready.rpc_url,
    rootAccountId: ready.root_account_id,
    rootSecretKey: ready.root_secret_key as KeyPairString,
    stop: () => stopChild(child),
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  child.stdin?.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  await exited;
  clearTimeout(timer);
}

/** base58(sha256(wasm)): what `view_account.code_hash` reports for a deployed contract. */
export function codeHashOf(wasm: Uint8Array): string {
  return baseEncode(createHash('sha256').update(wasm).digest());
}

export interface DemoVault {
  vaultId: string;
  ownerId: string;
  payeeId: string;
  attackerId: string;
  /** Owner key (here the sandbox genesis key, used for every demo account). */
  ownerSecretKey: KeyPairString;
  agentSecretKey: KeyPairString;
  agentPublicKey: string;
  codeHash: string;
}

export interface BootstrapOptions {
  node: Pick<SandboxNode, 'rpcUrl' | 'rootAccountId' | 'rootSecretKey'>;
  policy: (accounts: { payeeId: string }) => Policy;
  /** NEAR deposited into the vault by the owner (default "5"). */
  depositNear?: string;
  wasmPath?: string;
  log?: (line: string) => void;
}

/**
 * Create owner / payee / attacker accounts, deploy and initialise the vault,
 * fund it, and register a freshly generated agent key with `policy`. The
 * agent key is returned in memory; the caller decides where (if anywhere)
 * to keep it.
 */
export async function bootstrapVault(options: BootstrapOptions): Promise<DemoVault> {
  const log = options.log ?? (() => {});
  const { node } = options;
  const provider = new JsonRpcProvider({ url: node.rpcUrl });
  const root = new Account(node.rootAccountId, provider, node.rootSecretKey);
  const rootPk = KeyPair.fromString(node.rootSecretKey).getPublicKey();
  const name = (prefix: string): string => `${prefix}.${node.rootAccountId}`;
  const ids = { ownerId: name('owner'), payeeId: name('api'), attackerId: name('attacker'), vaultId: name('vault') };

  for (const [id, amount] of [[ids.ownerId, '50'], [ids.payeeId, '5'], [ids.attackerId, '5']] as const) {
    await root.createAccount({ newAccountId: id, publicKey: rootPk, nearToTransfer: nearToYocto(amount) });
    log(`created ${id} (${amount} NEAR)`);
  }
  const wasm = readFileSync(options.wasmPath ?? VAULT_WASM);
  await root.signAndSendTransaction({
    receiverId: ids.vaultId,
    actions: [
      actions.createAccount(),
      actions.transfer(nearToYocto('10')),
      actions.addFullAccessKey(rootPk),
      actions.deployContract(wasm),
      actions.functionCall('new', { owner_id: ids.ownerId }, teraToGas('30'), 0n),
    ],
  });
  const codeHash = codeHashOf(wasm);
  log(`deployed the vault contract on ${ids.vaultId} (code hash ${codeHash}), owner ${ids.ownerId}`);

  const owner = new OwnerClient({ vaultId: ids.vaultId, ownerId: ids.ownerId, rpcUrl: node.rpcUrl, ownerKey: node.rootSecretKey });
  const depositNear = options.depositNear ?? '5';
  await owner.deposit(parseNear(depositNear));
  log(`owner deposited ${depositNear} NEAR into the vault`);

  const agentKey = KeyPair.fromRandom('ed25519');
  const agentPublicKey = agentKey.getPublicKey().toString();
  const added = await owner.addAgent({ key: agentPublicKey }, 'worker', options.policy({ payeeId: ids.payeeId }));
  if (added.value !== true) throw new Error('add_agent did not register the agent');
  log(`registered agent key ${agentPublicKey} as a function-call key on ${ids.vaultId}`);

  return {
    ...ids,
    ownerSecretKey: node.rootSecretKey,
    agentSecretKey: agentKey.toString() as KeyPairString,
    agentPublicKey,
    codeHash,
  };
}

export interface DemoToken {
  tokenId: string;
  symbol: string;
  decimals: number;
  /** A second agent key whose policy is in this token. */
  agentSecretKey: KeyPairString;
  agentPublicKey: string;
}

export interface TokenBootstrapOptions {
  node: Pick<SandboxNode, 'rpcUrl' | 'rootAccountId' | 'rootSecretKey'>;
  demo: Pick<DemoVault, 'vaultId' | 'ownerId' | 'payeeId'>;
  policy: (accounts: { payeeId: string; tokenId: string; decimals: number }) => Policy;
  /** Default "SUSD" (a sandbox-only stand-in for a USD stablecoin), 6 decimals. */
  symbol?: string;
  decimals?: number;
  /** Tokens the owner deposits into the vault with ft_transfer_call (default "100"). */
  fund?: string;
  wasmPath?: string;
  log?: (line: string) => void;
}

/**
 * NEP-141 scenario on the sandbox: deploy the test token on `usd.<root>`
 * with the whole supply minted to the owner, have the owner register it with
 * the vault (attaching NEAR so the vault registers itself on the token),
 * fund the vault with `ft_transfer_call`, and register a second agent key
 * whose policy is in that token. The payee is deliberately NOT registered on
 * the token: the vault's first payment registers it.
 */
export async function bootstrapToken(options: TokenBootstrapOptions): Promise<DemoToken> {
  const log = options.log ?? (() => {});
  const { node, demo } = options;
  const symbol = options.symbol ?? 'SUSD';
  const decimals = options.decimals ?? 6;
  const provider = new JsonRpcProvider({ url: node.rpcUrl });
  const root = new Account(node.rootAccountId, provider, node.rootSecretKey);
  const rootPk = KeyPair.fromString(node.rootSecretKey).getPublicKey();
  const tokenId = `usd.${node.rootAccountId}`;
  const wasm = readFileSync(options.wasmPath ?? TOKEN_WASM);
  await root.signAndSendTransaction({
    receiverId: tokenId,
    actions: [
      actions.createAccount(),
      actions.transfer(nearToYocto('5')),
      actions.addFullAccessKey(rootPk),
      actions.deployContract(wasm),
      actions.functionCall(
        'new',
        { owner_id: demo.ownerId, total_supply: parseUnits('1000000', decimals).toString(), symbol, decimals },
        teraToGas('30'),
        0n,
      ),
    ],
  });
  setTokenDisplay(tokenId, { symbol, decimals });
  log(`deployed a NEP-141 test token on ${tokenId} (${symbol}, ${decimals} decimals), supply minted to ${demo.ownerId}`);

  const owner = new OwnerClient({ vaultId: demo.vaultId, ownerId: demo.ownerId, rpcUrl: node.rpcUrl, ownerKey: node.rootSecretKey });
  await owner.registerToken(tokenId, { attachYocto: parseNear('0.01') });
  log(`owner registered ${tokenId} with the vault (the vault paid its own storage on the token)`);

  const fund = options.fund ?? '100';
  const ownerAccount = new Account(demo.ownerId, provider, node.rootSecretKey);
  await ownerAccount.callFunctionRaw({
    contractId: tokenId,
    methodName: 'ft_transfer_call',
    args: { receiver_id: demo.vaultId, amount: parseUnits(fund, decimals).toString(), msg: 'treasury top-up' },
    gas: teraToGas('100'),
    deposit: 1n,
  });
  log(`owner deposited ${fund} ${symbol} into the vault with ft_transfer_call`);

  const agentKey = KeyPair.fromRandom('ed25519');
  const agentPublicKey = agentKey.getPublicKey().toString();
  const added = await owner.addAgent({ key: agentPublicKey }, 'usd-worker', options.policy({ payeeId: demo.payeeId, tokenId, decimals }));
  if (added.value !== true) throw new Error('add_agent did not register the token agent');
  log(`registered a second agent key ${agentPublicKey} with a ${symbol} policy`);
  return { tokenId, symbol, decimals, agentSecretKey: agentKey.toString() as KeyPairString, agentPublicKey };
}
