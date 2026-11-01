/**
 * Allowance as an MCP server: any MCP client (Claude Desktop, Claude Code,
 * an agent framework) gets a budget, not a wallet.
 *
 * The server holds one thing: the agent's function-call key on the vault
 * account. The NEAR protocol limits that key to `pay`, `confirm_delivery`
 * and `ping` on the vault, with no deposit, and the vault's on-chain policy
 * decides every amount and payee. So the tools below are safe to hand to a
 * model that may be prompt-injected: the worst it can do is spend inside the
 * policy, and anything above the approval threshold waits for a human.
 *
 * What the server adds on top of the SDK:
 *   - `allowance_pay` always runs the counterparty check (when configured)
 *     and the free `simulate` first, and refuses to sign on `block`; there is
 *     no "force" option, so a refused payment never reaches the chain;
 *   - the key is never returned, logged or accepted as a tool argument;
 *   - no owner tools: approving, denying, changing the policy and the kill
 *     switch stay with the owner's key, outside the model's reach.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  AllowanceError,
  describePolicy,
  describeReceipt,
  describeRejection,
  describeStatus,
  formatAmount,
  guardedPay,
  isAccountId,
  isNear,
  parseAssetAmount,
  shortKey,
  tokenOf,
  type AllowanceClient,
  type Asset,
  type Receipt,
} from '@allowance/sdk';

export const SERVER_NAME = 'allowance';
export const SERVER_VERSION = '0.1.0';

/** Counterparty check before a payment, e.g. `riskPrecheck(new CounterpartyRisk(...))` from `@allowance/risk`. */
export type Precheck = (payee: string) => Promise<{ verdict: 'allow' | 'warn' | 'block'; reason?: string; note: string }>;

export interface ToolsOptions {
  /** Agent client: it must hold the function-call key (`agentKey`). */
  client: AllowanceClient;
  precheck?: Precheck;
  /** Diagnostics; the stdio server writes them to stderr (stdout carries the protocol). */
  log?: (line: string) => void;
}

/** What a tool returns: text for the model, and the same facts as JSON. */
export interface ToolResult {
  text: string;
  data: Record<string, unknown>;
  isError?: boolean;
}

const MAX_RECEIPTS = 50;

/**
 * The tool logic, independent of the MCP transport (tests call it directly).
 * Every amount is a decimal in the agent policy's asset ("0.02" NEAR, "2"
 * of a token), or base units with a "units" suffix.
 */
export class AllowanceTools {
  readonly #client: AllowanceClient;
  readonly #precheck: Precheck | undefined;
  readonly #log: (line: string) => void;
  #asset: Asset | undefined;

  constructor(options: ToolsOptions) {
    this.#client = options.client;
    this.#precheck = options.precheck;
    this.#log = options.log ?? (() => {});
  }

  /** The policy's asset; for a token, also loads its decimals for parsing and display. */
  async asset(): Promise<Asset> {
    if (this.#asset !== undefined) return this.#asset;
    const agent = await this.#client.agent();
    const asset = agent?.policy.asset ?? 'near';
    const token = tokenOf(asset);
    if (token !== null) await this.#client.ftMetadata(token).catch(() => undefined);
    this.#asset = asset;
    return asset;
  }

  async status(): Promise<ToolResult> {
    const [agent, vault] = await Promise.all([this.#client.agent(), this.#client.vault()]);
    if (!agent) {
      return { isError: true, text: 'this key is not a registered agent of the vault (it was removed, or the vault was killed)', data: { registered: false } };
    }
    const asset = agent.policy.asset ?? 'near';
    const budget = agent.remaining_budget === null ? 'no budget window' : `${formatAmount(agent.remaining_budget, asset)} left in this window`;
    const lines = [
      `vault ${this.#client.vaultId}${vault.paused ? ' (PAUSED: every payment is refused)' : ''}`,
      `agent ${shortKey('key' in agent.id ? agent.id.key : agent.id.account)} "${agent.label}": ${agent.active ? 'active' : 'disabled'}${agent.auto_disabled ? ' by the vault after repeated refusals' : ''}`,
      `budget: ${budget}`,
      'policy (enforced on-chain on every pay):',
      ...describePolicy(agent.policy).map((l) => `  ${l}`),
    ];
    return {
      text: lines.join('\n'),
      data: {
        vault: this.#client.vaultId,
        paused: vault.paused,
        active: agent.active,
        asset,
        remaining_budget: agent.remaining_budget,
        policy_version: agent.policy_version,
      },
    };
  }

  async checkPayee(payee: string): Promise<ToolResult> {
    assertPayee(payee);
    if (!this.#precheck) return { text: 'no counterparty-risk service configured; the vault policy still applies', data: { payee, verdict: null } };
    const r = await this.#precheck(payee);
    return { text: `counterparty check ${payee}: ${r.verdict.toUpperCase()}${r.reason ? ` (${r.reason})` : ''}`, data: { payee, ...r } };
  }

  async simulate(payee: string, amount: string): Promise<ToolResult> {
    assertPayee(payee);
    const asset = await this.asset();
    const base = parseAssetAmount(amount, asset);
    const s = await this.#client.simulate(payee, base, isNear(asset) ? {} : { asset });
    const why = s.reason ? `: ${describeRejection(s.reason, asset)}` : s.verdict === 'needs_approval' ? ': a human must approve it' : '';
    const left = s.remaining_budget === null ? '' : `; budget left ${formatAmount(s.remaining_budget, asset)}`;
    return {
      text: `simulate ${formatAmount(base, asset)} -> ${payee}: ${s.verdict}${why}${left} (free view, nothing signed)`,
      data: { payee, amount: base.toString(), asset, verdict: s.verdict, reason: s.reason, remaining_budget: s.remaining_budget },
    };
  }

  async pay(args: { payee: string; amount: string; memo?: string | undefined; requestHash?: string | undefined }): Promise<ToolResult> {
    assertPayee(args.payee);
    const asset = await this.asset();
    const amount = parseAssetAmount(args.amount, asset);
    let memo = args.memo ?? '';
    if (this.#precheck) {
      const risk = await this.#precheck(args.payee);
      if (risk.verdict === 'block') {
        this.#log(`refused before signing: counterparty check blocked ${args.payee}`);
        return {
          isError: true,
          text: `REFUSED before signing: the counterparty check blocked ${args.payee}${risk.reason ? ` (${risk.reason})` : ''}. Nothing was sent.`,
          data: { status: 'refused', stage: 'counterparty', payee: args.payee, reason: risk.reason ?? null },
        };
      }
      memo = memo ? `${memo} ${risk.note}` : risk.note;
    }
    const lines: string[] = [];
    const result = await guardedPay(
      this.#client,
      { payee: args.payee, amount, asset, ...(memo ? { memo } : {}), ...(args.requestHash ? { requestHash: args.requestHash } : {}) },
      (l) => lines.push(l),
    );
    for (const l of lines) this.#log(l);
    if (result.status === 'refused') {
      return {
        isError: true,
        text: `REFUSED before signing: ${result.reason}. Nothing was sent.`,
        data: { status: 'refused', stage: 'simulate', payee: args.payee, reason: result.simulation.reason },
      };
    }
    const o = result.result.outcome;
    const tx = result.result.txHash;
    const head = `${formatAmount(amount, asset)} -> ${args.payee}`;
    switch (o.outcome) {
      case 'paid':
        return { text: `PAID ${head}: receipt #${o.receipt_id}, tx ${tx}. Give the receipt id to the seller; it verifies it with one view call.`, data: { status: 'paid', receipt_id: o.receipt_id, tx } };
      case 'needs_approval':
        return {
          text: `WAITING FOR A HUMAN: ${head} is above the approval threshold. Approval request #${o.pending_id}, receipt #${o.receipt_id}; check it later with allowance_receipt.`,
          data: { status: 'needs_approval', receipt_id: o.receipt_id, pending_id: o.pending_id, tx },
        };
      case 'rejected':
        return { isError: true, text: `REJECTED on-chain: ${describeRejection(o.reason, asset)} (receipt #${o.receipt_id}, tx ${tx})`, data: { status: 'rejected', receipt_id: o.receipt_id, reason: o.reason, tx } };
      default:
        return { isError: true, text: `payment ${o.outcome} (receipt #${o.receipt_id}, tx ${tx})`, data: { status: o.outcome, receipt_id: o.receipt_id, tx } };
    }
  }

  async receipt(receiptId: number): Promise<ToolResult> {
    const r = await this.#client.receipt(receiptId);
    if (!r) return { isError: true, text: `no receipt #${receiptId}`, data: { receipt_id: receiptId, found: false } };
    return { text: receiptLine(r), data: { receipt: r } };
  }

  async receipts(limit: number): Promise<ToolResult> {
    const n = Math.min(Math.max(1, Math.floor(limit)), MAX_RECEIPTS);
    const info = await this.#client.vault();
    const fromId = Math.max(info.first_receipt_id, info.next_receipt_id - n);
    const list = info.next_receipt_id > fromId ? await this.#client.receipts({ fromId, limit: n }) : [];
    return { text: list.length ? list.map(receiptLine).join('\n') : 'no receipts yet', data: { receipts: list } };
  }

  async confirmDelivery(receiptId: number, passed: boolean): Promise<ToolResult> {
    const tx = await this.#client.confirmDelivery(receiptId, passed);
    return { text: `receipt #${receiptId} marked ${passed ? 'delivered' : 'NOT delivered'} on-chain (tx ${tx.txHash})`, data: { receipt_id: receiptId, passed, tx: tx.txHash } };
  }
}

function receiptLine(r: Receipt): string {
  return `#${r.id} ${r.kind} ${describeStatus(r.status)}: ${describeReceipt(r)}`;
}

function assertPayee(payee: string): void {
  if (!isAccountId(payee)) throw new AllowanceError('config', `invalid NEAR account id: ${JSON.stringify(payee)}`);
}

const amountArg = z.string().min(1).max(64).describe('decimal amount in the policy asset, e.g. "0.02" (NEAR) or "2" (token); "1500000units" for base units');
const payeeArg = z.string().min(2).max(64).describe('NEAR account id of the receiver, e.g. "api.example.near"');
const receiptArg = z.number().int().min(0).describe('receipt id returned by allowance_pay');

/** Register the Allowance tools on an MCP server. */
export function createServer(tools: AllowanceTools): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const run = async (fn: () => Promise<ToolResult>) => {
    try {
      const r = await fn();
      return { content: [{ type: 'text' as const, text: r.text }], structuredContent: r.data, ...(r.isError ? { isError: true } : {}) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `error: ${msg}` }], isError: true };
    }
  };
  const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool(
    'allowance_status',
    { title: 'Budget and policy', description: 'Show this agent\'s spending policy, its remaining budget and whether the vault is paused. Free, signs nothing.', annotations: readOnly },
    () => run(() => tools.status()),
  );
  server.registerTool(
    'allowance_check_payee',
    { title: 'Counterparty check', description: 'Off-chain risk check of a payee before paying it: deny-lists, account age, recent contract code changes, history in this vault. Returns allow, warn or block.', inputSchema: { payee: payeeArg }, annotations: readOnly },
    ({ payee }) => run(() => tools.checkPayee(payee)),
  );
  server.registerTool(
    'allowance_simulate',
    { title: 'Dry-run a payment', description: 'Ask the vault, with a free view call, whether a payment would be allowed, need human approval, or be blocked, and why. Signs nothing.', inputSchema: { payee: payeeArg, amount: amountArg }, annotations: readOnly },
    ({ payee, amount }) => run(() => tools.simulate(payee, amount)),
  );
  server.registerTool(
    'allowance_pay',
    {
      title: 'Pay from the vault',
      description:
        'Pay a NEAR account from the vault. Runs the counterparty check and simulate first and refuses on block; the vault enforces its policy again on-chain. Above the approval threshold the payment waits for a human. Returns a receipt id the seller can verify.',
      inputSchema: {
        payee: payeeArg,
        amount: amountArg,
        memo: z.string().max(200).optional().describe('what is being bought, kept in the on-chain receipt'),
        request_hash: z.string().max(64).optional().describe('base64 request hash from an HTTP 402 quote, if the seller gave one'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ payee, amount, memo, request_hash }) => run(() => tools.pay({ payee, amount, memo, requestHash: request_hash })),
  );
  server.registerTool(
    'allowance_receipt',
    { title: 'One receipt', description: 'Read one on-chain receipt: status (paid, rejected, waiting for approval, denied...), payee, amount, memo, delivery.', inputSchema: { receipt_id: receiptArg }, annotations: readOnly },
    ({ receipt_id }) => run(() => tools.receipt(receipt_id)),
  );
  server.registerTool(
    'allowance_receipts',
    { title: 'Recent receipts', description: 'List the vault\'s newest receipts.', inputSchema: { limit: z.number().int().min(1).max(MAX_RECEIPTS).optional().describe('how many, default 10') }, annotations: readOnly },
    ({ limit }) => run(() => tools.receipts(limit ?? 10)),
  );
  server.registerTool(
    'allowance_confirm_delivery',
    { title: 'Confirm delivery', description: 'Record on-chain whether what a paid receipt bought was actually delivered. Failed deliveries count against the payee in later counterparty checks.', inputSchema: { receipt_id: receiptArg, passed: z.boolean() }, annotations: { idempotentHint: true, openWorldHint: true } },
    ({ receipt_id, passed }) => run(() => tools.confirmDelivery(receipt_id, passed)),
  );
  return server;
}
