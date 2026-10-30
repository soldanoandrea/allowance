import type { AllowanceClient, PayResult } from '../client.ts';
import { describeRejection } from '../describe.ts';
import type { Simulation } from '../types.ts';
import { near } from '../units.ts';

export type Log = (line: string) => void;

export interface GuardedPayRequest {
  payee: string;
  amount: bigint;
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
  const simulation = request.simulation ?? (await client.simulate(request.payee, request.amount));
  if (!request.simulation) logSimulation(log, request.payee, request.amount, simulation);
  if (simulation.verdict === 'block') {
    const reason = simulation.reason ? describeRejection(simulation.reason) : 'blocked by policy';
    log(`REFUSED before signing: ${reason}`);
    return { status: 'refused', reason, simulation };
  }
  const result = await client.pay({
    payee: request.payee,
    amount: request.amount,
    ...(request.memo !== undefined ? { memo: request.memo } : {}),
    ...(request.requestHash !== undefined ? { requestHash: request.requestHash } : {}),
  });
  logPayResult(log, result);
  return { status: 'sent', result, simulation };
}

export function logSimulation(log: Log, payee: string, amount: bigint, s: Simulation): void {
  const why = s.reason ? ` (${describeRejection(s.reason)})` : '';
  const budget = s.remaining_budget === null ? '' : `, budget left ${near(s.remaining_budget)}`;
  log(`simulate pay ${near(amount)} -> ${payee}: ${s.verdict.toUpperCase()}${why}${budget}`);
}

export function logPayResult(log: Log, result: PayResult): void {
  const o = result.outcome;
  const detail =
    o.outcome === 'rejected'
      ? ` - ${describeRejection(o.reason)}`
      : o.outcome === 'needs_approval'
        ? ` - approval request #${o.pending_id}`
        : '';
  log(`pay tx ${result.txHash}: ${o.outcome} (receipt #${o.receipt_id})${detail}`);
  for (const e of result.events) log(`  event ${e.event} ${JSON.stringify(e.data)}`);
}

