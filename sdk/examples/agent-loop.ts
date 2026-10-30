/**
 * Scripted agent task loop (feature 5): the agent needs market data from a
 * paid API to write a short NEAR/USDC report. For every dataset it:
 *
 *   1. calls the API and gets HTTP 402 with a price and a payee;
 *   2. runs the free `simulate` view on its vault;
 *   3. allow          -> pays, retries with the receipt, checks the data,
 *                        records confirm_delivery(passed);
 *      needs_approval -> makes ONE counteroffer (X-Allowance-Offer) at the
 *                        most it may pay alone; if the seller refuses, pays
 *                        the list price and waits for the owner's approval;
 *      block          -> refuses and logs why.
 *
 *   node sdk/examples/agent-loop.ts --vault vault.sandbox --rpc http://127.0.0.1:3030 \
 *        --api http://127.0.0.1:8402 --key-file examples/local_demo/.tmp/agent-key.json [--planner llm]
 */
import { near, runPaidTask, type PaidTask, type TaskResult } from '../src/index.ts';
import { exampleConfig } from './common.ts';

interface Candle {
  close: number;
}

function body(data: unknown): Record<string, unknown> {
  const d = (data as { data?: unknown }).data;
  return typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : {};
}

const config = exampleConfig(process.argv.slice(2), '[agent]');
const { client, apiUrl, log } = config;

const tasks: PaidTask[] = [
  {
    name: 'daily candles for the NEAR/USDC report',
    url: `${apiUrl}/dataset`,
    check: (d) => Array.isArray(body(d)['rows']) && (body(d)['rows'] as unknown[]).length === 30,
  },
  {
    name: 'order-book depth to estimate slippage',
    url: `${apiUrl}/dataset/premium`,
    check: (d) => Array.isArray(body(d)['bids']) && (body(d)['bids'] as unknown[]).length === 50,
  },
  {
    name: 'a year of hourly candles for the backtest',
    url: `${apiUrl}/dataset/archive`,
    check: (d) => typeof body(d)['rows'] === 'number' && (body(d)['rows'] as number) > 8000,
  },
];

log(`planner: ${config.planner.name}; vault ${client.vaultId}`);
const results: Array<{ task: PaidTask; result: TaskResult }> = [];
for (const task of tasks) {
  log('');
  const result = await runPaidTask(task, {
    client,
    planner: config.planner,
    log,
    approvalTimeoutMs: config.approvalTimeoutMs,
  });
  results.push({ task, result });
  log(`=> ${result.status}${result.status === 'delivered' ? '' : `: ${result.reason}`}`);
}

log('');
log('summary');
let spent = 0n;
for (const { task, result } of results) {
  if (result.status === 'delivered') {
    spent += result.paidYocto;
    const how = [
      result.counteroffer ? `counteroffer ${result.counteroffer.status}` : null,
      result.approved ? 'approved by the owner' : null,
    ].filter(Boolean).join(', ');
    log(`  ${task.name}: delivered for ${near(result.paidYocto)} (receipt #${result.receiptId}${how ? `, ${how}` : ''})`);
  } else {
    log(`  ${task.name}: ${result.status} - ${result.reason}`);
  }
}
log(`  total spent ${near(spent)}`);

// The deliverable: a two-line report from the data the agent bought.
const candles = results[0]?.result.status === 'delivered' ? (body(results[0].result.data)['rows'] as Candle[]) : [];
const depth = results[1]?.result.status === 'delivered' ? body(results[1].result.data) : {};
if (candles.length > 0) {
  const avg = candles.reduce((s, c) => s + c.close, 0) / candles.length;
  log(`report: NEAR/USDC 30-day average close ${avg.toFixed(3)}, last close ${candles[candles.length - 1]?.close.toFixed(3)}`);
}
const bids = depth['bids'] as Array<[number, number]> | undefined;
const asks = depth['asks'] as Array<[number, number]> | undefined;
if (bids?.[0] && asks?.[0]) log(`report: top-of-book spread ${(asks[0][0] - bids[0][0]).toFixed(4)} USDC`);

process.exitCode = results.every((r) => r.result.status !== 'failed') ? 0 : 1;
