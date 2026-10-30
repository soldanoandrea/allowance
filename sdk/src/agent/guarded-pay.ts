import { formatAmount, isNear } from '../asset.ts';
import type { AllowanceClient, PayResult } from '../client.ts';
import { describeFailure, describeRejection } from '../describe.ts';
import type { Asset, Simulation } from '../types.ts';

export type Log = (line: string) => void;

export interface GuardedPayRequest {
  payee: string;
  /** Base units of `asset`. */
  amount: bigint;
  /** Default NEAR. */
  asset?: Asset;
  memo?: string;
  requestHash?: string;
  /** A simulation the caller already ran for this exact payment. */
  simulation?: Simulation;
}

export type GuardedPayResult =
  | { status: 'refused'; reason: string; simulation: Simulation }
  | { status: 'sent'; result: PayResult; simulation: Simulation };

/**
 * The agent-side wrapper: run the free `simulate` view first and refuse to
 * sign anything the policy would block. The contract enforces the same
 * policy again on-chain, so this saves gas and a rejection receipt, it is not
 * the security boundary.
 */
export async function guardedPay(client: AllowanceClient, request: GuardedPayRequest, log: Log): Promise<GuardedPayResult> {
  const asset = request.asset ?? 'near';
  const simulation =
    request.simulation ?? (await client.simulate(request.payee, request.amount, isNear(asset) ? {} : { asset }));
  if (!request.simulation) logSimulation(log, request.payee, request.amount, simulation, asset);
  if (simulation.verdict === 'block') {
    const reason = simulation.reason ? describeRejection(simulation.reason, asset) : 'blocked by policy';
    log(`REFUSED before signing: ${reason}`);
    return { status: 'refused', reason, simulation };
  }
  const result = await client.pay({
    payee: request.payee,
    amount: request.amount,
    ...(isNear(asset) ? {} : { asset }),
    ...(request.memo !== undefined ? { memo: request.memo } : {}),
    ...(request.requestHash !== undefined ? { requestHash: request.requestHash } : {}),
  });
  logPayResult(log, result, asset);
  return { status: 'sent', result, simulation };
}

export function logSimulation(log: Log, payee: string, amount: bigint, s: Simulation, asset: Asset = 'near'): void {
  const why = s.reason ? ` (${describeRejection(s.reason, asset)})` : '';
  const budget = s.remaining_budget === null ? '' : `, budget left ${formatAmount(s.remaining_budget, asset)}`;
  log(`simulate pay ${formatAmount(amount, asset)} -> ${payee}: ${s.verdict.toUpperCase()}${why}${budget}`);
}

export function logPayResult(log: Log, result: PayResult, asset: Asset = 'near'): void {
  const o = result.outcome;
  const detail =
    o.outcome === 'rejected'
      ? ` - ${describeRejection(o.reason, asset)}`
      : o.outcome === 'needs_approval'
        ? ` - approval request #${o.pending_id}`
        : o.outcome === 'failed'
          ? ` - ${describeFailure(o.reason)}`
          : '';
  log(`pay tx ${result.txHash}: ${o.outcome} (receipt #${o.receipt_id})${detail}`);
  for (const e of result.events) log(`  event ${e.event} ${JSON.stringify(e.data)}`);
}
