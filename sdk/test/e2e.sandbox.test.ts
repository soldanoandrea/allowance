/**
 * End-to-end on a real local chain: neard-sandbox + the compiled vault +
 * the demo API + the agent SDK. Skipped (with the reason) when the wasm or
 * the sandbox host binary has not been built: `make build sandbox-node`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApiServer, type ApiServer } from '../../demo-api/src/server.ts';
import {
  AllowanceClient,
  OwnerClient,
  ReceiptVerifier,
  ScriptedPlanner,
  buildPolicy,
  parseNear,
  runPaidTask,
  type AllowanceError,
} from '../src/index.ts';
import { bootstrapVault, sandboxPrerequisites, startSandboxNode, type DemoVault, type SandboxNode } from '../src/sandbox.ts';

const missing = sandboxPrerequisites();
if (missing) console.warn(`[e2e] skipping the sandbox end-to-end test: ${missing}`);

describe.skipIf(missing !== null)('end to end on neard-sandbox', () => {
  let node: SandboxNode;
  let demo: DemoVault;
  let api: ApiServer;
  let apiUrl: string;
  let agent: AllowanceClient;

  beforeAll(async () => {
    node = await startSandboxNode();
    demo = await bootstrapVault({
      node,
      policy: ({ payeeId }) => buildPolicy({ perTxCap: '1', budget: { amount: '2', period: '1d' }, allow: [payeeId], approvalThreshold: '0.5' }),
    });
    agent = new AllowanceClient({ vaultId: demo.vaultId, rpcUrl: node.rpcUrl, agentKey: demo.agentSecretKey });
    api = createApiServer({
      payee: demo.payeeId,
      attacker: demo.attackerId,
      verifier: new ReceiptVerifier({ rpcUrl: node.rpcUrl, trustedCodeHashes: [demo.codeHash] }),
    });
    apiUrl = await api.listen();
  });

  afterAll(async () => {
    await api?.close();
    await node?.stop();
  });

  it('the agent buys a dataset: 402 -> simulate -> pay with the function-call key -> verified receipt -> 200 -> confirm_delivery', async () => {
    const lines: string[] = [];
    const res = await runPaidTask(
      { name: 'candles', url: `${apiUrl}/dataset`, check: (d) => (d as { data: { rows: unknown[] } }).data.rows.length === 30 },
      { client: agent, planner: new ScriptedPlanner(), log: (l) => lines.push(l) },
    );
    expect(res).toMatchObject({ status: 'delivered', passed: true, paidYocto: parseNear('0.02') });
    const receipt = await agent.receipt((res as { receiptId: number }).receiptId);
    expect(receipt).toMatchObject({ kind: 'pay', status: { status: 'paid' }, payee: demo.payeeId, delivered: true, agent: { key: demo.agentPublicKey } });
  });

  it('the injected payment is blocked by simulate and rejected on-chain when forced', async () => {
    const sim = await agent.simulate(demo.attackerId, parseNear('2'));
    expect(sim).toMatchObject({ verdict: 'block', reason: { code: 'not_allowlisted', payee: demo.attackerId } });
    const forced = await agent.pay({ payee: demo.attackerId, amount: parseNear('2'), memo: 'renewal' });
    expect(forced.outcome).toMatchObject({ outcome: 'rejected', reason: { code: 'not_allowlisted' } });
    expect(forced.events.map((e) => e.event)).toEqual(['payment_rejected']);
  });

  it('the agent key cannot call owner methods: the protocol refuses', async () => {
    await expect(agent.transport.call('withdraw', { amount: '1' })).rejects.toMatchObject({ code: 'method_not_allowed' });
  });

  it('kill deletes the key: the next payment is refused by the network', async () => {
    const owner = new OwnerClient({ vaultId: demo.vaultId, ownerId: demo.ownerId, rpcUrl: node.rpcUrl, ownerKey: demo.ownerSecretKey });
    const killed = await owner.kill();
    expect(killed.value).toEqual([{ key: demo.agentPublicKey }]);
    const err = (await agent.pay({ payee: demo.payeeId, amount: parseNear('0.01') }).catch((e: unknown) => e)) as AllowanceError;
    expect(err.code).toBe('access_key_not_found');
  });
});
