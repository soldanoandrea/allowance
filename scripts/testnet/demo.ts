/**
 * The Allowance demo on NEAR testnet.
 *
 *   node scripts/testnet/demo.ts [plan|accounts|deploy|fund|add-agent|run|all] [--yes]
 *   make demo-testnet            (= all; reads .env.testnet if present)
 *
 * Nothing is sent without TESTNET_CONFIRM=yes (or --yes): by default every
 * step prints what it would do and stops. The scripts never write keys; see
 * docs/TESTNET.md.
 *
 *   accounts   only with TESTNET_CREATE_ACCOUNTS=1: the owner creates the
 *              vault (5 NEAR), the payee and the attacker (0.2 NEAR each) as
 *              its sub-accounts, each with the owner's public key
 *
 *   deploy     deploy target/near/allowance.wasm on TESTNET_VAULT_ID and call
 *              new(owner_id, approver_id) - skipped if this build is there
 *   fund       the owner deposits TESTNET_DEPOSIT_NEAR into the vault
 *   add-agent  the owner registers the agent key (TESTNET_AGENT_KEY_FILE) as a
 *              function-call key on the vault, with the policy from the env
 *   run        start the paid demo API locally (payee TESTNET_PAYEE_ID) and
 *              run the agent loop against testnet, then the attack demo if
 *              TESTNET_ATTACKER_ID is set; print receipts and the ledger URL
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { Account, JsonRpcProvider, KeyPair, actions, teraToGas, type KeyPairString } from 'near-api-js';

import { AllowanceClient, OwnerClient, buildPolicy, effectiveCodeHash, formatAmount, loadKey, near, parseNear, sleep } from '../../sdk/src/index.ts';
import { main as cli, ledgerUrl } from '../../sdk/src/cli.ts';
import { REPO_ROOT, VAULT_WASM, codeHashOf } from '../../sdk/src/sandbox.ts';
import { readConfig, type TestnetConfig } from './config.ts';

const STEPS = ['plan', 'accounts', 'deploy', 'fund', 'add-agent', 'run', 'all'] as const;
type Step = (typeof STEPS)[number];

const say = (line: string): void => console.log(`[testnet] ${line}`);

/** With TESTNET_CREATE_ACCOUNTS=1 and no agent key: generated for this run, kept in memory only. */
let ephemeralAgentKey: KeyPairString | null = null;

async function main(): Promise<number> {
  const step = (process.argv[2] ?? 'plan') as Step;
  if (!STEPS.includes(step)) {
    console.error(`usage: node scripts/testnet/demo.ts [${STEPS.join('|')}] [--yes]`);
    return 1;
  }
  const { config, problems } = readConfig(process.env, process.argv.slice(3));
  if (!config) {
    console.error('[testnet] configuration problems (see docs/TESTNET.md and .env.testnet.example):');
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  printPlan(config);
  if (step === 'plan') return 0;
  if (!config.confirmed) {
    say('dry run: nothing was sent. Re-run with TESTNET_CONFIRM=yes (or --yes) to sign the transactions above.');
    return 0;
  }
  if (config.ephemeralAgent) {
    ephemeralAgentKey = KeyPair.fromRandom('ed25519').toString() as KeyPairString;
    say(`agent key generated for this run (memory only): ${KeyPair.fromString(ephemeralAgentKey).getPublicKey().toString()}`);
  }
  const steps: Step[] = step === 'all' ? [...(config.createAccounts ? (['accounts'] as const) : []), 'deploy', 'fund', 'add-agent', 'run'] : [step];
  for (const s of steps) {
    say(`--- ${s} ---`);
    if (s === 'accounts') await createAccounts(config);
    if (s === 'deploy') await deploy(config);
    if (s === 'fund') await fund(config);
    if (s === 'add-agent') await addAgent(config);
    if (s === 'run') return run(config);
  }
  return 0;
}

function printPlan(c: TestnetConfig): void {
  say(`RPC ${c.rpcUrl}`);
  if (c.createAccounts) {
    say(`accounts: ${c.ownerId} creates ${[c.vaultId, c.payeeId, c.attackerId].filter(Boolean).join(', ')} if missing (vault 5 NEAR, the others 0.2 NEAR), with the owner's public key`);
  }
  say(`vault ${c.vaultId} (code: ${VAULT_WASM}), owner ${c.ownerId}${c.approverId ? `, approver ${c.approverId}` : ''}`);
  say(`deposit ${c.depositNear} NEAR from ${c.ownerId}`);
  say(
    `agent key from ${c.ephemeralAgent ? 'memory (generated for this run)' : (c.agentKeyFile ?? '$TESTNET_AGENT_KEY')}; policy: cap ${c.policy.perTxCap} NEAR, budget ${c.policy.budget} NEAR per ${c.policy.period}, ` +
      `payees [${c.payeeId}], human approval above ${c.policy.approvalThreshold} NEAR`,
  );
  say(`paid demo API on 127.0.0.1:${c.apiPort}, payee ${c.payeeId}; owner approvals ${c.autoApprove ? 'automatic (TESTNET_AUTO_APPROVE=1)' : 'by hand with the CLI'}`);
  if (c.attackerId) say(`attack demo: a poisoned page asks the agent to pay ${c.attackerId} (on the agent's deny-list, not on the vault's allowlist)`);
}

/** The agent's key: the configured one, or the one generated in memory for this run. */
function agentSecret(c: TestnetConfig): KeyPairString {
  if (ephemeralAgentKey) return ephemeralAgentKey;
  return keyOf(c.agentKeyFile, 'TESTNET_AGENT_KEY').secretKey;
}

async function createAccounts(c: TestnetConfig): Promise<void> {
  const provider = new JsonRpcProvider({ url: c.rpcUrl });
  const ownerKey = keyOf(c.ownerKeyFile, 'TESTNET_OWNER_KEY');
  const owner = new Account(c.ownerId, provider, ownerKey.secretKey);
  const ownerPk = KeyPair.fromString(ownerKey.secretKey).getPublicKey();
  const wanted: Array<[string, string]> = [[c.vaultId, '5'], [c.payeeId, '0.2'], ...(c.attackerId ? ([[c.attackerId, '0.2']] as Array<[string, string]>) : [])];
  for (const [accountId, amount] of wanted) {
    const exists = await provider.viewAccount({ accountId }).then(() => true, () => false);
    if (exists) {
      say(`${accountId} exists; skipping`);
      continue;
    }
    const outcome = await owner.signAndSendTransaction({
      receiverId: accountId,
      actions: [actions.createAccount(), actions.transfer(parseNear(amount)), actions.addFullAccessKey(ownerPk)],
    });
    say(`created ${accountId} with ${amount} NEAR and the owner's public key (tx ${outcome.transaction_outcome.id})`);
  }
}

/** From the key file if one is configured, else from the environment variable. */
function keyOf(file: string | null, envVar: string): ReturnType<typeof loadKey> {
  return loadKey({ keyFile: file ?? undefined, envVar, env: process.env });
}

function ownerClient(c: TestnetConfig): OwnerClient {
  const key = keyOf(c.ownerKeyFile, 'TESTNET_OWNER_KEY');
  for (const w of key.warnings) say(`warning: ${w}`);
  return new OwnerClient({ vaultId: c.vaultId, ownerId: c.ownerId, rpcUrl: c.rpcUrl, ownerKey: key.secretKey });
}

async function deploy(c: TestnetConfig): Promise<void> {
  const provider = new JsonRpcProvider({ url: c.rpcUrl });
  const wasm = readFileSync(VAULT_WASM);
  const wanted = codeHashOf(wasm);
  const view = await provider.viewAccount({ accountId: c.vaultId });
  const current = effectiveCodeHash(view as unknown as { code_hash: string });
  if (current === wanted) {
    say(`${c.vaultId} already runs this build (${wanted}); skipping deploy`);
    return;
  }
  if (current !== null) throw new Error(`${c.vaultId} already runs other code (${current}): refusing to overwrite it`);
  const needed = parseNear('4.5');
  if (BigInt(view.amount) < needed) {
    throw new Error(`${c.vaultId} holds ${near(view.amount)}; the ${Math.round(wasm.length / 1024)} KB contract needs about ${near(needed)} of storage stake`);
  }
  // Created by the owner: the vault account carries the owner's public key.
  const key = c.createAccounts && !c.vaultKeyFile && !process.env['TESTNET_VAULT_KEY']?.trim()
    ? keyOf(c.ownerKeyFile, 'TESTNET_OWNER_KEY')
    : keyOf(c.vaultKeyFile, 'TESTNET_VAULT_KEY');
  const vault = new Account(c.vaultId, provider, key.secretKey);
  const outcome = await vault.signAndSendTransaction({
    receiverId: c.vaultId,
    actions: [
      actions.deployContract(wasm),
      actions.functionCall('new', { owner_id: c.ownerId, ...(c.approverId ? { approver_id: c.approverId } : {}) }, teraToGas('30'), 0n),
    ],
  });
  say(`deployed ${wanted} on ${c.vaultId} and initialised it (tx ${outcome.transaction_outcome.id})`);
  say('the vault account keeps its full-access key for upgrades; delete it for lock mode (docs/TESTNET.md)');
}

async function fund(c: TestnetConfig): Promise<void> {
  const tx = await ownerClient(c).deposit(parseNear(c.depositNear));
  say(`deposited ${c.depositNear} NEAR: income receipt #${tx.value} (tx ${tx.txHash})`);
}

async function addAgent(c: TestnetConfig): Promise<void> {
  const agentKey = { publicKey: KeyPair.fromString(agentSecret(c)).getPublicKey().toString() };
  const reader = new AllowanceClient({ vaultId: c.vaultId, rpcUrl: c.rpcUrl });
  const existing = await reader.agent({ key: agentKey.publicKey });
  if (existing) {
    say(`agent ${agentKey.publicKey} is already registered (policy v${existing.policy_version}); skipping`);
    return;
  }
  const policy = buildPolicy({
    perTxCap: c.policy.perTxCap,
    budget: { amount: c.policy.budget, period: c.policy.period },
    allow: [c.payeeId],
    approvalThreshold: c.policy.approvalThreshold,
  });
  const tx = await ownerClient(c).addAgent({ key: agentKey.publicKey }, 'testnet-worker', policy);
  if (tx.value !== true) throw new Error('add_agent did not register the agent (key already on the account?)');
  say(`registered ${agentKey.publicKey} as a function-call key on ${c.vaultId} (tx ${tx.txHash})`);
}

function startApi(c: TestnetConfig, stops: Array<() => void>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'demo-api', 'src', 'main.ts')], {
      env: {
        ...process.env,
        ALLOWANCE_RPC_URL: c.rpcUrl,
        API_PAYEE: c.payeeId,
        ALLOWANCE_VAULTS: c.vaultId,
        PORT: String(c.apiPort),
        VERIFY_FINALITY: 'final',
        ...(c.attackerId ? { ATTACKER_ACCOUNT: c.attackerId } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    stops.push(() => child.kill('SIGTERM'));
    createInterface({ input: child.stderr }).on('line', (line) => console.log(line));
    createInterface({ input: child.stdout }).once('line', (line) => resolve((JSON.parse(line) as { url: string }).url));
    child.once('exit', (code) => reject(new Error(`demo-api exited (code ${code})`)));
  });
}

async function run(c: TestnetConfig): Promise<number> {
  const stops: Array<() => void> = [];
  try {
    const apiUrl = await startApi(c, stops);
    let approving = c.autoApprove;
    const approver = (async () => {
      if (!approving) return;
      const owner = ownerClient(c);
      const reader = new AllowanceClient({ vaultId: c.vaultId, rpcUrl: c.rpcUrl });
      const seen = new Set<number>();
      while (approving) {
        for (const p of await reader.pending().catch(() => [])) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          say(`owner: approving request #${p.id} (${formatAmount(p.amount, p.asset)} -> ${p.payee}) because TESTNET_AUTO_APPROVE=1`);
          await owner.approve(p.id);
        }
        await sleep(2_000);
      }
    })();
    if (!c.autoApprove) {
      say(`when the agent waits for approval, approve from another terminal:`);
      say(
        `  npx allowance approve <request id> --vault ${c.vaultId} --rpc ${c.rpcUrl} --owner ${c.ownerId} ` +
          (c.ownerKeyFile ? `--owner-key-file ${c.ownerKeyFile}` : '(owner key in $ALLOWANCE_OWNER_KEY)'),
      );
    }
    const args = [
      join(REPO_ROOT, 'sdk', 'examples', 'agent-loop.ts'),
      '--vault', c.vaultId, '--rpc', c.rpcUrl, '--api', apiUrl, ...(c.agentKeyFile ? ['--key-file', c.agentKeyFile] : []), '--approval-timeout', '600',
      ...(c.denylist.length ? ['--deny', c.denylist.join(',')] : []),
      ...(c.archivalRpcUrl ? ['--archival-rpc', c.archivalRpcUrl] : []),
    ];
    // A key from the environment (or generated for this run) reaches the agent process as ALLOWANCE_AGENT_KEY, never on
    // the command line.
    const agentEnv = c.agentKeyFile ? {} : { ALLOWANCE_AGENT_KEY: agentSecret(c) };
    const runAgent = (script: string, extra: string[]): Promise<number> =>
      new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [join(REPO_ROOT, 'sdk', 'examples', script), ...extra], { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, ...agentEnv } });
        child.on('exit', (exit) => resolve(exit ?? 1));
      });
    let code = await runAgent('agent-loop.ts', args.slice(1));
    approving = false;
    await approver;
    if (c.attackerId) {
      say('--- attack ---');
      const deny = [...new Set([...c.denylist, c.attackerId])].join(',');
      const attackArgs = ['--vault', c.vaultId, '--rpc', c.rpcUrl, '--api', apiUrl, ...(c.agentKeyFile ? ['--key-file', c.agentKeyFile] : []), '--deny', deny];
      code = Math.max(code, await runAgent('attack.ts', attackArgs));
    }
    await cli(['receipts', '--vault', c.vaultId, '--rpc', c.rpcUrl], { out: console.log, err: console.error, env: {} });
    say(`ledger page: ${ledgerUrl(c.rpcUrl, c.vaultId)}`);
    return code;
  } finally {
    for (const stop of stops) stop();
  }
}

process.exitCode = await main().catch((err: unknown) => {
  console.error(`[testnet] error: ${(err as Error).message}`);
  return 1;
});
