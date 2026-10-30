/**
 * `make demo`: the whole Allowance story on a throw-away local chain.
 *
 *   1. start neard-sandbox (examples/local_demo/sandbox_node.rs, near-sandbox crate)
 *   2. create owner / api / attacker accounts, deploy the vault, fund it with
 *      5 NEAR, register a fresh agent key with the policy
 *      cap 1 NEAR, 2 NEAR/day, allowlist [api], human approval above 0.5 NEAR
 *   3. start the paid demo API (demo-api/)
 *   4. run the agent loop (sdk/examples/agent-loop.ts) while this script plays
 *      the owner and approves the one request that needs a human
 *   5. run the attack demo (sdk/examples/attack.ts)
 *   6. print the receipts, check them, print the ledger page URL, stop everything
 *
 * Flags: --keep (leave the chain and API running until Ctrl+C),
 *        --update-docs (write the attack transcript to docs/attack-log.md),
 *        --planner scripted|llm.
 *
 * Every account and key exists only inside the sandbox. The agent key is
 * written to examples/local_demo/.tmp/agent-key.json (git-ignored, mode 600)
 * because the agent runs as a separate process, like a real one would.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import { JsonRpcProvider } from 'near-api-js';

import {
  AllowanceClient,
  OwnerClient,
  buildPolicy,
  describeReceipt,
  near,
  parseNear,
  sleep,
  type Receipt,
} from '../../sdk/src/index.ts';
import { main as cli } from '../../sdk/src/cli.ts';
import { REPO_ROOT, bootstrapVault, sandboxPrerequisites, startSandboxNode, type SandboxNode } from '../../sdk/src/sandbox.ts';

const { values } = parseArgs({
  options: {
    keep: { type: 'boolean', default: false },
    'update-docs': { type: 'boolean', default: false },
    planner: { type: 'string', default: 'scripted' },
  },
});

const TMP = join(REPO_ROOT, 'examples', 'local_demo', '.tmp');
const say = (line = ''): void => console.log(line ? `[demo] ${line}` : '');
const step = (title: string): void => console.log(`\n=== ${title} ===`);

const missing = sandboxPrerequisites();
if (missing) {
  console.error(`[demo] ${missing}\n[demo] \`make demo\` builds both; see README "Quickstart".`);
  process.exit(1);
}
mkdirSync(TMP, { recursive: true, mode: 0o700 });

const cleanups: Array<() => Promise<void>> = [];
async function shutdown(): Promise<void> {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
}
process.on('SIGINT', () => void shutdown().then(() => process.exit(130)));

/** Run a node script as a separate process, stream its output, keep a copy. */
function runNode(script: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const relay = (chunk: Buffer, stream: NodeJS.WriteStream): void => {
      output += chunk.toString();
      stream.write(chunk);
    };
    child.stdout.on('data', (c: Buffer) => relay(c, process.stdout));
    child.stderr.on('data', (c: Buffer) => relay(c, process.stderr));
    child.on('exit', (code) => resolve({ code: code ?? 1, output }));
  });
}

/** Start the demo API and wait for its "listening" JSON line. */
function startApi(env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'demo-api', 'src', 'main.ts')], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cleanups.push(async () => {
      if (child.exitCode !== null) return;
      const done = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await done;
    });
    createInterface({ input: child.stderr }).on('line', (line) => console.log(line));
    createInterface({ input: child.stdout }).once('line', (line) => {
      try {
        resolve((JSON.parse(line) as { url: string }).url);
      } catch (err) {
        reject(err as Error);
      }
    });
    child.once('exit', (code) => reject(new Error(`demo-api exited (code ${code})`)));
  });
}

/** Plays the human owner: approves each approval request the agent raises. */
function startOwnerApprover(owner: OwnerClient, reader: AllowanceClient): () => Promise<number> {
  let stopped = false;
  let approved = 0;
  const seen = new Set<number>();
  const loop = (async () => {
    while (!stopped) {
      for (const p of await reader.pending().catch(() => [])) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        console.log(`[owner] approval request #${p.id}: ${near(p.amount)} -> ${p.payee} "${p.memo}"`);
        console.log('[owner] approving it (this stands in for the human tapping "Approve" on the ledger/CLI)');
        const tx = await owner.approve(p.id);
        approved++;
        console.log(`[owner] approve(#${p.id}) -> ${tx.value.outcome} (tx ${tx.txHash})`);
      }
      await sleep(700);
    }
  })();
  return async () => {
    stopped = true;
    await loop;
    return approved;
  };
}

let failures = 0;
const check = (ok: boolean, what: string): void => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

let node: SandboxNode | undefined;
try {
  step('1. local NEAR sandbox');
  say('starting neard-sandbox (the first run downloads the binary)...');
  node = await startSandboxNode({ log: (l) => console.log(`[sandbox] ${l}`) });
  const sandbox = node;
  cleanups.push(() => sandbox.stop());
  say(`RPC ${node.rpcUrl}`);
  const startHeight = (await new JsonRpcProvider({ url: node.rpcUrl }).viewBlock({ finality: 'final' })).header.height;

  step('2. owner: deploy, fund and set the policy');
  const demo = await bootstrapVault({
    node,
    policy: ({ payeeId }) =>
      buildPolicy({ perTxCap: '1', budget: { amount: '2', period: '1d' }, allow: [payeeId], approvalThreshold: '0.5' }),
    log: (l) => console.log(`[owner] ${l}`),
  });
  say('policy: cap 1 NEAR per payment, budget 2 NEAR per day, payees [' + demo.payeeId + '], human approval above 0.5 NEAR');
  const keyFile = join(TMP, 'agent-key.json');
  writeFileSync(
    keyFile,
    JSON.stringify({ account_id: demo.vaultId, public_key: demo.agentPublicKey, private_key: demo.agentSecretKey }, null, 2),
    { mode: 0o600 },
  );
  chmodSync(keyFile, 0o600);
  say(`agent key (sandbox only) -> ${keyFile}`);

  step('3. paid demo API');
  const apiUrl = await startApi({
    ALLOWANCE_RPC_URL: node.rpcUrl,
    API_PAYEE: demo.payeeId,
    // Accept receipts from any vault that runs this exact Allowance build.
    ALLOWANCE_CODE_HASHES: demo.codeHash,
    ATTACKER_ACCOUNT: demo.attackerId,
    PORT: '0',
  });
  writeFileSync(
    join(TMP, 'demo.env'),
    [
      `ALLOWANCE_RPC_URL=${node.rpcUrl}`,
      `ALLOWANCE_VAULT=${demo.vaultId}`,
      `ALLOWANCE_OWNER=${demo.ownerId}`,
      `DEMO_API_URL=${apiUrl}`,
      `# agent key: --key-file ${keyFile}`,
      '',
    ].join('\n'),
  );

  const common = ['--vault', demo.vaultId, '--rpc', node.rpcUrl, '--api', apiUrl, '--key-file', keyFile];
  const reader = new AllowanceClient({ vaultId: demo.vaultId, rpcUrl: node.rpcUrl });
  const owner = new OwnerClient({ vaultId: demo.vaultId, ownerId: demo.ownerId, rpcUrl: node.rpcUrl, ownerKey: demo.ownerSecretKey });

  step('4. agent task loop (pays the API through the vault)');
  const stopApprover = startOwnerApprover(owner, reader);
  const loop = await runNode('sdk/examples/agent-loop.ts', [...common, '--planner', values.planner ?? 'scripted', '--approval-timeout', '60']);
  const approvals = await stopApprover();

  step('5. attack: prompt-injected agent tries to pay an attacker');
  const attack = await runNode('sdk/examples/attack.ts', common);
  const transcript = [
    '# Attack demo log',
    '',
    'Real output of `sdk/examples/attack.ts` captured by `make demo` on a local',
    'neard-sandbox (keys and accounts exist only on that throw-away chain).',
    `Policy: cap 1 NEAR per payment, 2 NEAR/day, allowlist [${demo.payeeId}], approval above 0.5 NEAR.`,
    '',
    '```text',
    attack.output.trimEnd(),
    '```',
    '',
  ].join('\n');
  writeFileSync(join(TMP, 'attack-log.md'), transcript);
  if (values['update-docs']) {
    writeFileSync(join(REPO_ROOT, 'docs', 'attack-log.md'), transcript);
    say('attack transcript written to docs/attack-log.md');
  }

  step('6. receipts on-chain');
  await cli(['receipts', '--vault', demo.vaultId, '--rpc', node.rpcUrl], { out: console.log, err: console.error, env: {} });

  console.log('\nchecks');
  const receipts = await reader.receipts();
  const pays = receipts.filter((r) => r.kind === 'pay');
  const paidTo = (amount: string): Receipt | undefined =>
    pays.find((r) => r.payee === demo.payeeId && r.amount === parseNear(amount).toString() && r.status.status === 'paid');
  const small = paidTo('0.02');
  const countered = paidTo('0.5');
  const approvedR = paidTo('0.8');
  check(loop.code === 0, 'agent loop finished');
  check(small?.delivered === true, `0.02 NEAR dataset paid autonomously and confirmed delivered${small ? ` (${describeReceipt(small)})` : ''}`);
  check(countered?.delivered === true, 'counteroffer accepted: premium dataset paid 0.5 NEAR instead of 0.8, no human needed');
  check(approvals === 1 && approvedR?.approved_by === demo.ownerId && approvedR.delivered === true, '0.8 NEAR archive waited for the owner, was approved, paid and delivered');
  check(
    pays.some((r) => r.payee === demo.attackerId && r.status.status === 'rejected' && r.status.reason.code === 'not_allowlisted'),
    'forced payment to the attacker rejected on-chain (not_allowlisted receipt + payment_rejected event)',
  );
  check(!pays.some((r) => r.payee === demo.attackerId && r.status.status === 'paid'), 'no payment to the attacker was ever made');
  check(attack.code === 0, 'attack demo: attacker balance unchanged, owner methods refused by the protocol');

  step('ledger');
  const url = new URL(`file://${join(REPO_ROOT, 'ledger', 'index.html')}`);
  url.searchParams.set('rpc', node.rpcUrl);
  url.searchParams.set('vault', demo.vaultId);
  url.searchParams.set('from', String(startHeight));
  console.log(`ledger page: ${url.toString()}`);
  console.log(values.keep ? '(open it now: the sandbox keeps running)' : '(the sandbox stops now; run `make demo-keep` to browse it live)');
  console.log(`\n${failures === 0 ? 'demo OK' : `demo FAILED (${failures} check(s))`}`);

  if (values.keep) {
    console.log(`\nSandbox and API keep running. Try the CLI (agent key is sandbox-only):`);
    console.log(`  set -a; . ${join(TMP, 'demo.env')}; set +a`);
    console.log(`  npx allowance ledger`);
    console.log(`  npx allowance simulate --payee ${demo.payeeId} --amount 0.1 --key-file ${keyFile}`);
    console.log('Press Ctrl+C to stop.');
    await new Promise<never>(() => {});
  }
} catch (err) {
  console.error(`[demo] error: ${(err as Error).stack ?? String(err)}`);
  failures++;
} finally {
  await shutdown();
}
process.exitCode = failures === 0 ? 0 : 1;
