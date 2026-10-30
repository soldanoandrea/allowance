import { formatAmount, isNear, sameAsset, tokenDisplay, tokenOf } from '../asset.ts';
import type { AllowanceClient } from '../client.ts';
import { describeFailure, describeRejection, describeStatus } from '../describe.ts';
import type { Asset, Simulation } from '../types.ts';
import { HEADERS, parsePaymentRequired, receiptHeader, type Counteroffer, type PaymentRequired } from '../x402.ts';
import { guardedPay, logSimulation, type Log } from './guarded-pay.ts';
import { enforceGuardrails, type Planner } from './planner.ts';

export interface PaidTask {
  /** What the agent is trying to achieve (shown to the planner and in logs). */
  name: string;
  url: string;
  /** Acceptance check of the delivered data -> `confirm_delivery(passed)`. */
  check?: (data: unknown) => boolean;
}

export interface PaidTaskDeps {
  client: AllowanceClient;
  planner: Planner;
  log: Log;
  fetchImpl?: typeof fetch;
  /** How long to wait for a human approval (default 120 s). */
  approvalTimeoutMs?: number;
  approvalPollMs?: number;
  /**
   * Optional check of the payee before anything else (e.g. the
   * counterparty-risk service in risk/). `block` refuses the task; any
   * `note` is appended to the payment memo, which the receipt keeps.
   */
  precheck?: (payee: string, quote: PaymentRequired) => Promise<{ verdict: 'allow' | 'warn' | 'block'; note?: string; reason?: string }>;
}

export type TaskResult =
  | {
      status: 'delivered';
      data: unknown;
      /** null when the resource was free. */
      receiptId: number | null;
      /** Base units of `asset`. */
      paidAmount: bigint;
      asset: Asset;
      passed: boolean;
      counteroffer: Counteroffer | null;
      approved: boolean;
    }
  | { status: 'refused'; reason: string; receiptId: number | null }
  | { status: 'failed'; reason: string; receiptId: number | null };

/**
 * One task of the agent loop: fetch a resource; on HTTP 402 run `simulate`,
 * let the planner pick pay / counteroffer / refuse, pay through the vault,
 * wait for the owner if the payment needs approval, retry with the receipt,
 * check what was delivered and record the verdict on-chain.
 */
export async function runPaidTask(task: PaidTask, deps: PaidTaskDeps): Promise<TaskResult> {
  const { client, log } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  log(`task: ${task.name}`);
  log(`GET ${task.url}`);
  let response = await fetchImpl(task.url);
  if (response.ok) {
    log(`HTTP ${response.status}: free resource`);
    return { status: 'delivered', data: await response.json(), receiptId: null, paidAmount: 0n, asset: 'near', passed: true, counteroffer: null, approved: false };
  }
  if (response.status !== 402) return { status: 'failed', reason: `HTTP ${response.status}`, receiptId: null };

  let quote = await readQuote(response);
  const asset = quote.asset;
  await learnTokenDisplay(client, asset);
  log(`HTTP 402: ${formatAmount(quote.amount, asset)} to ${quote.payee} for "${quote.description}"`);
  if (!acceptsVault(quote, client.vaultId)) {
    return { status: 'refused', reason: `the API does not accept receipts from ${client.vaultId}`, receiptId: null };
  }

  let note = '';
  if (deps.precheck) {
    const check = await deps.precheck(quote.payee, quote);
    log(`counterparty check ${quote.payee}: ${check.verdict.toUpperCase()}${check.reason ? ` (${check.reason})` : ''}`);
    if (check.verdict === 'block') return { status: 'refused', reason: `counterparty check: ${check.reason ?? 'blocked'}`, receiptId: null };
    note = check.note ?? '';
  }

  const approvalThreshold = await ownThreshold(client, asset);
  let counterofferUsed = false;
  let counteroffer: Counteroffer | null = null;
  let simulation: Simulation;
  for (;;) {
    const price = BigInt(quote.amount);
    simulation = await client.simulate(quote.payee, price, isNear(asset) ? {} : { asset });
    logSimulation(log, quote.payee, price, simulation, asset);
    const input = { task: task.name, quote, simulation, counterofferUsed, approvalThreshold };
    const plan = enforceGuardrails(await deps.planner.decide(input), input);
    log(`plan (${deps.planner.name}): ${plan.action}${plan.action === 'counteroffer' ? ` ${formatAmount(plan.amountYocto, asset)}` : ''} - ${plan.reason}`);
    if (plan.action === 'refuse') return { status: 'refused', reason: plan.reason, receiptId: null };
    if (plan.action === 'pay') break;

    counterofferUsed = true;
    log(`GET ${task.url}  ${HEADERS.offer}: ${plan.amountYocto}`);
    response = await fetchImpl(task.url, {
      headers: { [HEADERS.offer]: plan.amountYocto.toString(), [HEADERS.offerReason]: plan.reason.slice(0, 300) },
    });
    if (response.status !== 402) return { status: 'failed', reason: `counteroffer answered with HTTP ${response.status}`, receiptId: null };
    quote = await readQuote(response);
    if (!sameAsset(quote.asset, asset)) return { status: 'failed', reason: 'the seller changed the asset of the quote', receiptId: null };
    counteroffer = quote.counteroffer ?? null;
    log(`counteroffer ${counteroffer?.status ?? 'ignored'} by the seller: ${counteroffer?.reason ?? ''} -> new quote ${formatAmount(quote.amount, asset)}`);
  }

  // Pay (the wrapper re-checks the verdict before signing).
  const price = BigInt(quote.amount);
  const paid = await guardedPay(
    client,
    { payee: quote.payee, amount: price, asset, memo: memoFor(task, quote, note), requestHash: quote.request_hash_base64, simulation },
    log,
  );
  if (paid.status === 'refused') return { status: 'refused', reason: paid.reason, receiptId: null };
  const outcome = paid.result.outcome;
  let approved = false;
  if (outcome.outcome === 'rejected') {
    return { status: 'refused', reason: describeRejection(outcome.reason, asset), receiptId: outcome.receipt_id };
  }
  if (outcome.outcome === 'failed') {
    return { status: 'failed', reason: `payment failed: ${describeFailure(outcome.reason)}`, receiptId: outcome.receipt_id };
  }
  if (outcome.outcome === 'expired') {
    return { status: 'failed', reason: 'payment expired', receiptId: outcome.receipt_id };
  }
  if (outcome.outcome === 'needs_approval') {
    log(`waiting for the owner to approve request #${outcome.pending_id} (receipt #${outcome.receipt_id})...`);
    let last = '';
    const settled = await client.waitForSettlement(outcome.receipt_id, {
      timeoutMs: deps.approvalTimeoutMs ?? 120_000,
      intervalMs: deps.approvalPollMs ?? 1_000,
      onPoll: (r) => {
        const s = describeStatus(r.status);
        if (s !== last) log(`  receipt #${r.id}: ${s}${r.approved_by ? ` by ${r.approved_by}` : ''}`);
        last = s;
      },
    });
    if (settled.status.status !== 'paid') {
      return { status: 'refused', reason: `owner did not approve: receipt ${describeStatus(settled.status)}`, receiptId: settled.id };
    }
    approved = true;
  }
  const receiptId = outcome.receipt_id;

  // Retry with the receipt.
  log(`GET ${task.url}  ${HEADERS.receipt}: ${receiptHeader(client.vaultId, receiptId)}`);
  response = await fetchImpl(task.url, {
    headers: { [HEADERS.receipt]: receiptHeader(client.vaultId, receiptId), [HEADERS.nonce]: quote.nonce },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; error_detail?: string };
    return { status: 'failed', reason: `retry refused: HTTP ${response.status} ${body.error ?? ''} ${body.error_detail ?? ''}`.trim(), receiptId };
  }
  const data: unknown = await response.json();
  const passed = task.check ? safeCheck(task.check, data) : true;
  log(`HTTP ${response.status}: delivered; acceptance check ${passed ? 'passed' : 'FAILED'}`);
  const confirm = await client.confirmDelivery(receiptId, passed);
  log(`confirm_delivery(#${receiptId}, ${passed}) tx ${confirm.txHash}`);
  return { status: 'delivered', data, receiptId, paidAmount: price, asset, passed, counteroffer, approved };
}

async function readQuote(response: Response): Promise<PaymentRequired> {
  return parsePaymentRequired(await response.json());
}

function acceptsVault(quote: PaymentRequired, vaultId: string): boolean {
  return quote.accepts.code_hashes.length > 0 || quote.accepts.vaults.includes(vaultId);
}

/** The agent's approval threshold, if its policy is in the quote's asset. */
async function ownThreshold(client: AllowanceClient, asset: Asset): Promise<bigint | null> {
  if (!client.agentId) return null;
  const me = await client.agent();
  if (!me || !sameAsset(me.policy.asset ?? 'near', asset)) return null;
  const threshold = me.policy.approval_threshold;
  return threshold ? BigInt(threshold) : null;
}

/** For tokens: read symbol and decimals from the chain once, for readable logs. */
async function learnTokenDisplay(client: AllowanceClient, asset: Asset): Promise<void> {
  const token = tokenOf(asset);
  if (token === null || tokenDisplay(token)) return;
  await client.ftMetadata(token).catch(() => undefined);
}

/** `task | resource` plus an optional note (e.g. the counterparty check), within 256 bytes. */
function memoFor(task: PaidTask, quote: PaymentRequired, note = ''): string {
  const base = `${task.name} | ${quote.resource}`;
  const memo = note ? `${base} | ${note}` : base;
  if (Buffer.byteLength(memo) <= 256) return memo;
  const short = note ? `${quote.resource} | ${note}` : quote.resource;
  return Buffer.byteLength(short) <= 256 ? short : Buffer.from(short).subarray(0, 256).toString('utf8').replace(/\uFFFD+$/, '');
}

function safeCheck(check: (data: unknown) => boolean, data: unknown): boolean {
  try {
    return check(data);
  } catch {
    return false;
  }
}
