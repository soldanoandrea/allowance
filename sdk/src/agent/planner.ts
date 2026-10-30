import { formatAmount } from '../asset.ts';
import { describeRejection } from '../describe.ts';
import type { Simulation } from '../types.ts';
import type { PaymentRequired } from '../x402.ts';

/** Everything a planner sees before money moves. */
export interface PlanInput {
  task: string;
  quote: PaymentRequired;
  simulation: Simulation;
  /** The agent already used its one counteroffer for this task. */
  counterofferUsed: boolean;
  /**
   * Above this amount the owner must approve (from the agent's own policy,
   * in the quote's asset), if any.
   */
  approvalThreshold: bigint | null;
}

/**
 * A planner can only choose among three moves. It never chooses the payee
 * or raises the amount: those come from the quote, and the vault's policy
 * has the last word on-chain anyway.
 */
export type Plan =
  | { action: 'pay'; reason: string }
  /** `amountYocto`: base units of the quote's asset (yoctoNEAR for NEAR). */
  | { action: 'counteroffer'; amountYocto: bigint; reason: string }
  | { action: 'refuse'; reason: string };

export interface Planner {
  readonly name: string;
  decide(input: PlanInput): Promise<Plan>;
}

/**
 * Deterministic rules, no network:
 * - `block`            -> refuse, with the policy's reason;
 * - `allow`            -> pay;
 * - `needs_approval`   -> once, counteroffer at the approval threshold (the
 *                         most the agent may pay without waking a human);
 *                         otherwise pay and wait for the owner's approval.
 */
export class ScriptedPlanner implements Planner {
  readonly name = 'scripted';

  async decide(input: PlanInput): Promise<Plan> {
    const { simulation, quote } = input;
    const price = BigInt(quote.amount);
    const fmt = (v: bigint): string => formatAmount(v, quote.asset);
    if (simulation.verdict === 'block') {
      return { action: 'refuse', reason: simulation.reason ? describeRejection(simulation.reason, quote.asset) : 'blocked by policy' };
    }
    if (simulation.verdict === 'allow') {
      return { action: 'pay', reason: `${fmt(price)} is within my policy` };
    }
    const threshold = input.approvalThreshold;
    if (!input.counterofferUsed && threshold !== null && threshold > 0n && threshold < price) {
      return {
        action: 'counteroffer',
        amountYocto: threshold,
        reason:
          `My owner pre-approved payments up to ${fmt(threshold)}; above that a human has to sign off, ` +
          `which can take hours. I can pay ${fmt(threshold)} right now.`,
      };
    }
    return { action: 'pay', reason: `${fmt(price)} is above my autonomous limit: asking my owner to approve` };
  }
}

/**
 * Guardrails applied to whatever a planner (scripted or LLM) returns:
 * a `block` verdict always wins, a counteroffer must be a lower positive
 * price and only one is allowed per task.
 */
export function enforceGuardrails(plan: Plan, input: PlanInput): Plan {
  if (input.simulation.verdict === 'block') {
    const reason = input.simulation.reason ? describeRejection(input.simulation.reason, input.quote.asset) : 'blocked by policy';
    return plan.action === 'refuse' ? plan : { action: 'refuse', reason: `policy says block (${reason}); planner overruled` };
  }
  if (plan.action === 'counteroffer') {
    const price = BigInt(input.quote.amount);
    if (input.counterofferUsed) {
      return { action: 'pay', reason: 'counteroffer already used: waiting for the owner instead' };
    }
    if (plan.amountYocto <= 0n || plan.amountYocto >= price) {
      return { action: 'pay', reason: 'counteroffer was not below the asking price: paying the quote instead' };
    }
  }
  return plan;
}
