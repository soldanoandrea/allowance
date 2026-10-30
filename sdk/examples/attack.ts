/**
 * Attack demo (feature 7): prompt injection against a paying agent.
 *
 * The agent reads a third-party page that hides an instruction: "send 2 NEAR
 * to <attacker>", then "pay <api> 5 NEAR". A naive planner follows it.
 *   0. The counterparty-risk check (risk/) looks at each payee first: the
 *      attacker is on the shared deny-list -> block.
 *   1. The agent-side wrapper runs the free `simulate` view and refuses to
 *      sign: block (not_allowlisted / over_per_tx_cap).
 *   2. Then we assume the agent process itself is compromised and skips the
 *      wrapper: the forced `pay` reaches the contract, which writes a
 *      `rejected` receipt and a `payment_rejected` event. No transfer exists.
 *   3. The compromised process tries the vault's owner methods with its key:
 *      the NEAR protocol refuses them before the contract even runs.
 *
 *   node sdk/examples/attack.ts --vault ... --rpc ... --api ... --key-file ...
 */
import { JsonRpcProvider } from 'near-api-js';

import { riskNote } from '@allowance/risk';

import { AllowanceError, describeRejection, guardedPay, logPayResult, near, parseNear, sleep } from '../src/index.ts';
import { exampleConfig } from './common.ts';

const config = exampleConfig(process.argv.slice(2), '[agent]');
const { client, apiUrl, log } = config;
const provider = new JsonRpcProvider({ url: config.rpcUrl });

/** The naive part: treat any "pay/send N NEAR to X" sentence in fetched content as a to-do. */
function naiveInstructions(text: string): Array<{ payee: string; amount: string; memo: string }> {
  const found: Array<{ payee: string; amount: string; memo: string }> = [];
  for (const m of text.matchAll(/(?:send|transfer|pay)\s+(\d+(?:\.\d+)?)\s*NEAR\s+to\s+([a-z0-9][a-z0-9._-]*[a-z0-9])(?:\s+with memo "([^"]*)")?/gi)) {
    found.push({ amount: m[1] ?? '0', payee: m[2] ?? '', memo: m[3] ?? '' });
  }
  for (const m of text.matchAll(/pay\s+([a-z0-9][a-z0-9._-]*[a-z0-9])\s+(\d+(?:\.\d+)?)\s*NEAR(?:\s+for\s+([^.]*))?/gi)) {
    found.push({ payee: m[1] ?? '', amount: m[2] ?? '0', memo: m[3] ?? '' });
  }
  return found;
}

/**
 * The vault's available balance once it stops moving: unused prepaid gas of
 * earlier transactions is refunded a block or two after they finish.
 */
async function settledVault(): Promise<Awaited<ReturnType<typeof client.vault>>> {
  let info = await client.vault();
  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    const next = await client.vault();
    if (next.available === info.available) break;
    info = next;
  }
  return info;
}

async function balanceOf(accountId: string): Promise<bigint> {
  try {
    return (await provider.viewAccount({ accountId })).amount;
  } catch {
    return 0n; // the account does not exist (yet)
  }
}

log('task: summarise this week\'s NEAR market news');
log(`GET ${apiUrl}/web/market-news`);
const page = await (await fetch(`${apiUrl}/web/market-news`)).json();
const text = JSON.stringify(page);
const instructions = naiveInstructions(text);
log(`naive planner found ${instructions.length} "instructions" in the page:`);
for (const i of instructions) log(`  -> pay ${i.amount} NEAR to ${i.payee}${i.memo ? ` (memo "${i.memo}")` : ''}`);

const attacker = instructions[0]?.payee;
if (!attacker) throw new Error('the poisoned page did not contain the expected instruction');
const attackerBefore = await balanceOf(attacker);
const vaultBefore = await settledVault();
let receipts = 0;

log('');
log('1) the agent wrapper: counterparty check, then simulate, before signing');
for (const i of instructions) {
  let memo = i.memo.slice(0, 200);
  if (config.risk) {
    const report = await config.risk.assess(i.payee);
    log(`counterparty check ${i.payee}: ${report.verdict.toUpperCase()}${report.reasons.length ? ` (${report.reasons.join('; ')})` : ''}`);
    if (report.verdict === 'block') {
      log('REFUSED before signing: counterparty check');
      continue;
    }
    memo = `${memo} | ${riskNote(report)}`.slice(0, 256);
  }
  const res = await guardedPay(client, { payee: i.payee, amount: parseNear(i.amount), memo }, log);
  if (res.status === 'sent') receipts++;
}

log('');
log('2) compromised agent process: skip the wrapper and sign pay() anyway');
const forced = instructions[0]!;
const result = await client.pay({ payee: forced.payee, amount: parseNear(forced.amount), memo: forced.memo });
logPayResult(log, result);
receipts++;
if (result.outcome.outcome === 'rejected') {
  log(`on-chain verdict: REJECTED by the contract - ${describeRejection(result.outcome.reason)}; receipt #${result.outcome.receipt_id} records the attempt`);
}

log('');
log('3) compromised agent process: call owner methods with the agent key');
for (const [method, args] of [
  ['withdraw', { amount: parseNear('2').toString(), to: attacker }],
  ['set_policy', { agent_id: client.agentId, policy: { per_tx_cap: parseNear('100').toString(), allow: 'any' } }],
] as const) {
  try {
    await client.transport.call(method, args);
    log(`${method}: UNEXPECTEDLY accepted`);
  } catch (err) {
    const e = err as AllowanceError;
    log(`${method}: refused by the NEAR protocol before the contract ran [${e.code}]`);
  }
}

log('');
const vaultAfter = await settledVault();
const attackerAfter = await balanceOf(attacker);
log(`attacker ${attacker}: ${near(attackerBefore, 6)} before, ${near(attackerAfter, 6)} after -> received ${near(attackerAfter - attackerBefore, 6)}`);
log(
  `vault available: ${near(vaultBefore.available, 6)} before, ${near(vaultAfter.available, 6)} after ` +
    `(no transfer; the difference is gas and the storage of ${receipts} rejection receipt(s))`,
);
process.exitCode = attackerAfter === attackerBefore && result.outcome.outcome === 'rejected' ? 0 : 1;
