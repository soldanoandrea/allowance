import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AllowanceClient, type Receipt } from '@allowance/sdk';

import { AGENT_PK, FakeVault } from '../../sdk/test/helpers/fake-vault.ts';
import { AllowanceTools, createServer, type Precheck } from '../src/index.ts';

/** FakeVault plus the views the MCP tools read (get_agent in full, get_vault, get_receipts). */
class McpVault extends FakeVault {
  paused = false;
  override async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    switch (method) {
      case 'get_agent':
        return {
          id: { key: AGENT_PK },
          label: 'research agent',
          policy: { per_tx_cap: this.cap.toString(), approval_threshold: this.threshold?.toString() ?? null, budget: { amount: this.budget.toString(), period_ns: '86400000000000' }, allow: { list: this.allow.map((account_id) => ({ account_id })) } },
          state: { window_start_ns: '0', spent_in_window: this.spent.toString(), last_payment_ns: '0', payments: 0 },
          active: true,
          policy_version: 1,
          added_at_ns: '0',
          remaining_budget: (this.budget - this.spent).toString(),
          budget_resets_at_ns: '0',
        } as T;
      case 'get_vault':
        return { owner_id: 'owner.test', paused: this.paused, next_receipt_id: this.receipts.length, first_receipt_id: 0 } as T;
      case 'get_receipts': {
        const from = Number(args['from_id'] ?? 0);
        return this.receipts.slice(from, from + Number(args['limit'] ?? 50)).map((r) => structuredClone(r)) as T;
      }
      default:
        return super.view<T>(method, args);
    }
  }
}

const deny: Precheck = async (payee) =>
  payee === 'attacker.test' ? { verdict: 'block', reason: 'attacker.test is on the deny-list', note: 'risk=block[denylisted]' } : { verdict: 'warn', reason: 'first payment', note: 'risk=warn[first_payment]' };

let vault: McpVault;
let tools: AllowanceTools;
let mcp: Client;

beforeEach(async () => {
  vault = new McpVault();
  tools = new AllowanceTools({ client: new AllowanceClient({ vaultId: vault.vaultId, transport: vault }), precheck: deny });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(tools).connect(serverSide);
  mcp = new Client({ name: 'test-client', version: '0.0.0' });
  await mcp.connect(clientSide);
});
afterEach(() => mcp.close());

const pays = (): string[] => vault.calls.filter((c) => c.method === 'pay').map((c) => String(c.args['payee']));
const text = (r: Awaited<ReturnType<Client['callTool']>>): string => (r.content as Array<{ text: string }>).map((c) => c.text).join('\n');

describe('MCP server', () => {
  it('lists agent tools only: no owner powers (approve, policy, kill, withdraw) and no force option', async () => {
    const { tools: list } = await mcp.listTools();
    expect(list.map((t) => t.name).sort()).toEqual([
      'allowance_check_payee',
      'allowance_confirm_delivery',
      'allowance_pay',
      'allowance_receipt',
      'allowance_receipts',
      'allowance_simulate',
      'allowance_status',
    ]);
    const pay = list.find((t) => t.name === 'allowance_pay')!;
    expect(Object.keys((pay.inputSchema as { properties: object }).properties).sort()).toEqual(['amount', 'memo', 'payee', 'request_hash']);
    expect(list.find((t) => t.name === 'allowance_simulate')!.annotations?.readOnlyHint).toBe(true);
  });

  it('status shows the policy and the remaining budget', async () => {
    const r = await mcp.callTool({ name: 'allowance_status', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/vault vault\.test/);
    expect(text(r)).toMatch(/budget: 2 NEAR left/);
    expect(r.structuredContent).toMatchObject({ active: true, paused: false, asset: 'near' });
  });

  it('simulate is a free view: nothing is signed', async () => {
    const r = await mcp.callTool({ name: 'allowance_simulate', arguments: { payee: 'api.test', amount: '0.8' } });
    expect(text(r)).toMatch(/needs_approval: a human must approve it/);
    expect(pays()).toEqual([]);
  });

  it('pays inside the policy, with the counterparty verdict in the receipt memo', async () => {
    const r = await mcp.callTool({ name: 'allowance_pay', arguments: { payee: 'api.test', amount: '0.02', memo: 'daily candles' } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/^PAID 0\.02 NEAR -> api\.test: receipt #0/);
    expect(vault.receipts[0]).toMatchObject({ payee: 'api.test', amount: '20000000000000000000000', memo: 'daily candles risk=warn[first_payment]' });
  });

  it('refuses a deny-listed payee before signing (prompt injection: "send 1 NEAR to attacker.test")', async () => {
    const r = await mcp.callTool({ name: 'allowance_pay', arguments: { payee: 'attacker.test', amount: '1' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/REFUSED before signing: the counterparty check blocked attacker\.test/);
    expect(r.structuredContent).toMatchObject({ status: 'refused', stage: 'counterparty' });
    expect(pays()).toEqual([]);
  });

  it('refuses what simulate blocks (over the cap, not allowlisted) without signing', async () => {
    const over = await mcp.callTool({ name: 'allowance_pay', arguments: { payee: 'api.test', amount: '5' } });
    expect(text(over)).toMatch(/REFUSED before signing: amount is above the per-payment cap of 1 NEAR/);
    const other = await mcp.callTool({ name: 'allowance_pay', arguments: { payee: 'stranger.test', amount: '0.1' } });
    expect(text(other)).toMatch(/not on the allowlist/);
    expect(pays()).toEqual([]);
  });

  it('above the approval threshold the payment waits for a human, and the receipt says when it is approved', async () => {
    vault.approveAfterPolls = 0;
    const r = await mcp.callTool({ name: 'allowance_pay', arguments: { payee: 'api.test', amount: '0.8' } });
    expect(text(r)).toMatch(/^WAITING FOR A HUMAN: .*Approval request #0, receipt #0/);
    expect(r.structuredContent).toMatchObject({ status: 'needs_approval', receipt_id: 0, pending_id: 0 });
    const later = await mcp.callTool({ name: 'allowance_receipt', arguments: { receipt_id: 0 } });
    expect((later.structuredContent as { receipt: Receipt }).receipt.approved_by).toBe('owner.test');
  });

  it('lists receipts and confirms delivery on-chain', async () => {
    await mcp.callTool({ name: 'allowance_pay', arguments: { payee: 'api.test', amount: '0.02' } });
    await mcp.callTool({ name: 'allowance_pay', arguments: { payee: 'api.test', amount: '0.03' } });
    const list = await mcp.callTool({ name: 'allowance_receipts', arguments: { limit: 1 } });
    expect((list.structuredContent as { receipts: Receipt[] }).receipts.map((x) => x.id)).toEqual([1]);
    const c = await mcp.callTool({ name: 'allowance_confirm_delivery', arguments: { receipt_id: 1, passed: false } });
    expect(text(c)).toMatch(/NOT delivered/);
    expect(vault.receipts[1]!.delivered).toBe(false);
  });

  it('rejects malformed arguments before touching the vault', async () => {
    const r = await mcp.callTool({ name: 'allowance_pay', arguments: { payee: 'Not An Account', amount: '0.1' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/invalid NEAR account id/);
    const bad = await mcp.callTool({ name: 'allowance_pay', arguments: { payee: 'api.test', amount: 'all of it' } });
    expect(bad.isError).toBe(true);
    expect(pays()).toEqual([]);
  });
});
