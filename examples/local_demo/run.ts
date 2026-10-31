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
 *   4b. NEP-141: a second agent, whose policy is in a test stablecoin (SUSD,
 *      6 decimals), buys a dataset priced in it; the vault registers the API
 *      on the token (storage_deposit) and pays with ft_transfer
 *   5. run the attack demo (sdk/examples/attack.ts)
 *   6. business: the API operator keeps its revenue in its own Allowance
 *      vault with a revenue split; the agent pays that vault vault-to-vault
 *      (through its `deposit`) and the split forwards 10% / 5% shares
 *   7. print the receipts, check them, print the ledger page URL, stop everything
 *
 * Flags: --keep (leave the chain and API running until Ctrl+C),
 *        --update-docs (write the attack transcript to docs/attack-log.md),
 *        --planner scripted|llm,
 *        --no-ft (skip the NEP-141 scenario),
 *        --manual-approve (you approve the waiting payment with the CLI
 *        instead of the script; for recording the video).
 *
 * With --keep or --manual-approve the owner's key (the sandbox genesis key, a
 * public constant) is also written to .tmp/owner-key.json for the CLI.
 *
 * Every account and key exists only inside the sandbox. The agent key is
 * written to examples/local_demo/.tmp/agent-key.json (git-ignored, mode 600)
 * because the agent runs as a separate process, like a real one would.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import { JsonRpcProvider, type KeyPairString } from 'near-api-js';

import {
  AllowanceClient,
  NearTransport,
  OwnerClient,
  buildPolicy,
  describeReceipt,
  describeSplit,
  formatAmount,
  guardedPay,
  parseNear,
  parseUnits,
  sleep,
  type Receipt,
} from '../../sdk/src/index.ts';
import { main as cli } from '../../sdk/src/cli.ts';
import {
  REPO_ROOT,
  bootstrapToken,
  bootstrapVault,
  createSandboxAccount,
  deployVault,
  sandboxPrerequisites,
  startSandboxNode,
  tokenPrerequisites,
  type DemoToken,
  type SandboxNode,
} from '../../sdk/src/sandbox.ts';

const { values } = parseArgs({
  options: {
    keep: { type: 'boolean', default: false },
    'update-docs': { type: 'boolean', default: false },
    planner: { type: 'string', default: 'scripted' },
    'no-ft': { type: 'boolean', default: false },
    'manual-approve': { type: 'boolean', default: false },
  },
});
const withFt = !values['no-ft'];

const TMP = join(REPO_ROOT, 'examples', 'local_demo', '.tmp');
const say = (line = ''): void => console.log(line ? `[demo] ${line}` : '');
/** Paths in the output are relative to the repository root (where `make` runs): no local paths in logs. */
const rel = (path: string): string => relative(REPO_ROOT, path);
const step = (title: string): void => console.log(`\n=== ${title} ===`);

const missing = sandboxPrerequisites() ?? (withFt ? tokenPrerequisites() : null);
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
    const child = spawn(process.execPath, [script, ...args], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
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
        console.log(`[owner] approval request #${p.id}: ${formatAmount(p.amount, p.asset)} -> ${p.payee} "${p.memo}"`);
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
  const writeKey = (name: string, publicKey: string, secretKey: KeyPairString): string => {
    const file = join(TMP, name);
    writeFileSync(file, JSON.stringify({ account_id: demo.vaultId, public_key: publicKey, private_key: secretKey }, null, 2), { mode: 0o600 });
    chmodSync(file, 0o600);
    return file;
  };
  const keyFile = writeKey('agent-key.json', demo.agentPublicKey, demo.agentSecretKey);
  say(`agent key (sandbox only) -> ${rel(keyFile)}`);
  const ownerKeyFile = join(TMP, 'owner-key.json');
  if (values.keep || values['manual-approve']) {
    writeFileSync(ownerKeyFile, JSON.stringify({ account_id: demo.ownerId, private_key: demo.ownerSecretKey }, null, 2), { mode: 0o600 });
    chmodSync(ownerKeyFile, 0o600);
    say(`owner key (sandbox genesis key, sandbox only) -> ${rel(ownerKeyFile)}`);
  }

  let token: DemoToken | undefined;
  let usdKeyFile = '';
  if (withFt) {
    token = await bootstrapToken({
      node,
      demo,
      policy: ({ payeeId, tokenId, decimals }) =>
        buildPolicy({
          asset: { ft: tokenId, decimals },
          perTxCap: '10',
          budget: { amount: '20', period: '1d' },
          allow: [payeeId],
          approvalThreshold: '5',
          ftStorageDeposit: '0.01',
        }),
      log: (l) => console.log(`[owner] ${l}`),
    });
    say(`token policy: cap 10 ${token.symbol}, budget 20 ${token.symbol} per day, payees [${demo.payeeId}], approval above 5 ${token.symbol}, may pay 0.01 NEAR to register a payee on the token`);
    usdKeyFile = writeKey('agent-usd-key.json', token.agentPublicKey, token.agentSecretKey);
    say(`token agent key (sandbox only) -> ${rel(usdKeyFile)}`);
  }

  step('3. paid demo API');
  const apiUrl = await startApi({
    ALLOWANCE_RPC_URL: node.rpcUrl,
    API_PAYEE: demo.payeeId,
    // Accept receipts from any vault that runs this exact Allowance build.
    ALLOWANCE_CODE_HASHES: demo.codeHash,
    ATTACKER_ACCOUNT: demo.attackerId,
    ...(token ? { API_FT_TOKEN: token.tokenId } : {}),
    PORT: '0',
  });
  writeFileSync(
    join(TMP, 'demo.env'),
    [
      `ALLOWANCE_RPC_URL=${node.rpcUrl}`,
      `ALLOWANCE_VAULT=${demo.vaultId}`,
      `ALLOWANCE_OWNER=${demo.ownerId}`,
      `DEMO_API_URL=${apiUrl}`,
      ...(token ? [`# NEP-141 test token: ${token.tokenId} (${token.symbol}); token agent key: --key-file ${rel(usdKeyFile)}`] : []),
      `# agent key: --key-file ${rel(keyFile)}`,
      '',
    ].join('\n'),
  );

  // Relative to the repo root (the children run there), so logs carry no local paths.
  // The attacker stands for an address on a shared scam list: the agents'
  // counterparty-risk check gets it as its deny-list.
  const common = ['--vault', demo.vaultId, '--rpc', node.rpcUrl, '--api', apiUrl, '--key-file', rel(keyFile), '--deny', demo.attackerId];
  const reader = new AllowanceClient({ vaultId: demo.vaultId, rpcUrl: node.rpcUrl });
  const owner = new OwnerClient({ vaultId: demo.vaultId, ownerId: demo.ownerId, rpcUrl: node.rpcUrl, ownerKey: demo.ownerSecretKey });

  step('4. agent task loop (pays the API through the vault)');
  const manual = values['manual-approve'];
  if (manual) {
    say('YOU are the owner: when the agent waits for approval, run in another terminal');
    say(`  npx allowance approve <request id> --vault ${demo.vaultId} --rpc ${node.rpcUrl} --owner ${demo.ownerId} --owner-key-file ${rel(ownerKeyFile)}`);
  }
  const stopApprover = manual ? async () => 1 : startOwnerApprover(owner, reader);
  const loop = await runNode('sdk/examples/agent-loop.ts', [...common, '--planner', values.planner ?? 'scripted', '--approval-timeout', manual ? '600' : '60']);
  const approvals = await stopApprover();

  let ftLoop = { code: 0, output: '' };
  let payeeTokens = 0n;
  if (token) {
    step('4b. NEP-141: a second agent pays in a test stablecoin');
    const usdArgs = ['--vault', demo.vaultId, '--rpc', node.rpcUrl, '--api', apiUrl, '--key-file', rel(usdKeyFile), '--deny', demo.attackerId];
    ftLoop = await runNode('sdk/examples/agent-loop.ts', [...usdArgs, '--scenario', 'ft', '--planner', values.planner ?? 'scripted']);
    const tokenView = new NearTransport({ rpcUrl: node.rpcUrl, vaultId: token.tokenId });
    payeeTokens = BigInt(await tokenView.view<string>('ft_balance_of', { account_id: demo.payeeId }));
    say(`${demo.payeeId} now holds ${formatAmount(payeeTokens, { ft: token.tokenId })} on ${token.tokenId}`);
  }

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

  step('6. business: revenue split, vault to vault');
  const shopId = `shop.${node.rootAccountId}`;
  const providerId = `provider.${node.rootAccountId}`;
  const opsId = `ops.${node.rootAccountId}`;
  await createSandboxAccount(node, providerId, '1');
  await createSandboxAccount(node, opsId, '1');
  await deployVault({ node, accountId: shopId, ownerId: demo.payeeId });
  say(`${demo.payeeId} (the API operator) keeps its revenue in its own vault ${shopId}`);
  const shopOwner = new OwnerClient({ vaultId: shopId, ownerId: demo.payeeId, rpcUrl: node.rpcUrl, ownerKey: demo.ownerSecretKey });
  await shopOwner.setSplit({ beneficiaries: [{ account_id: providerId, bps: 1000 }, { account_id: opsId, bps: 500 }] });
  say(`revenue split on ${shopId}: 10% of every income to ${providerId} (data provider), 5% to ${opsId}`);
  await owner.setPolicy(
    { key: demo.agentPublicKey },
    buildPolicy({ perTxCap: '1', budget: { amount: '2', period: '1d' }, allow: [demo.payeeId], allowVaults: [shopId], approvalThreshold: '0.5' }),
  );
  say(`owner allowlists ${shopId} as a vault payee (paid through its deposit): policy v2`);
  const providerBefore = BigInt((await new JsonRpcProvider({ url: node.rpcUrl }).viewAccount({ accountId: providerId })).amount);
  const worker = new AllowanceClient({ vaultId: demo.vaultId, rpcUrl: node.rpcUrl, agentKey: demo.agentSecretKey });
  const shopPay = await guardedPay(worker, { payee: shopId, amount: parseNear('0.1'), memo: 'monthly data-partner fee' }, (l) => console.log(`[agent] ${l}`));
  const shopReader = new AllowanceClient({ vaultId: shopId, rpcUrl: node.rpcUrl });
  const shopIncome = (await shopReader.receipts()).find((r) => r.kind === 'income' && r.split.length > 0);
  if (shopIncome) say(`${shopId} receipt: ${describeReceipt(shopIncome)}`);
  const providerGain =
    BigInt((await new JsonRpcProvider({ url: node.rpcUrl }).viewAccount({ accountId: providerId })).amount) - providerBefore;

  step('7. receipts on-chain');
  await cli(['receipts', '--vault', demo.vaultId, '--rpc', node.rpcUrl], {
    out: console.log,
    err: console.error,
    env: {},
    columns: process.stdout.isTTY ? process.stdout.columns : undefined,
  });

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
  check(
    shopPay.status === 'sent' &&
      shopPay.result.outcome.outcome === 'paid' &&
      shopIncome?.amount === parseNear('0.1').toString() &&
      shopIncome.split.every((p) => p.status === 'paid') &&
      providerGain === parseNear('0.01'),
    `business: vault-to-vault payment of 0.1 NEAR into ${shopId}, whose split forwarded 10% / 5% in the same transaction${shopIncome ? ` (${describeSplit(shopIncome)})` : ''}`,
  );
  check(
    /counterparty check attacker\.\S+: BLOCK/.test(attack.output) && pays.filter((r) => r.payee === demo.payeeId).every((r) => r.memo.includes('risk=')),
    'counterparty-risk check: attacker blocked by the deny-list before simulate; every API payment carries the risk verdict in its receipt memo',
  );
  if (token) {
    const price = parseUnits('2', token.decimals);
    const ftPaid = pays.find((r) => typeof r.asset === 'object' && r.asset.ft === token.tokenId && r.status.status === 'paid');
    check(
      ftLoop.code === 0 && ftPaid?.amount === price.toString() && ftPaid.delivered === true && ftPaid.storage_deposit !== null,
      `NEP-141: 2 ${token.symbol} paid with ft_transfer by the token agent, the vault registered the payee on the token first, delivered${ftPaid ? ` (${describeReceipt(ftPaid)})` : ''}`,
    );
    check(payeeTokens === price, `NEP-141: ${demo.payeeId} received exactly 2 ${token.symbol} on ${token.tokenId}`);
  }

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
    console.log(`  set -a; . ${rel(join(TMP, 'demo.env'))}; set +a`);
    console.log(`  npx allowance ledger`);
    console.log(`  npx allowance simulate --payee ${demo.payeeId} --amount 0.1 --key-file ${rel(keyFile)}`);
    console.log(`  npx allowance kill --owner ${demo.ownerId} --owner-key-file ${rel(ownerKeyFile)}`);
    console.log(`  npx allowance pay --payee ${demo.payeeId} --amount 0.01 --force --key-file ${rel(keyFile)}    # after kill: access_key_not_found`);
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
