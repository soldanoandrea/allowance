/**
 * End-to-end on a real local chain: neard-sandbox + the compiled vault +
 * the demo API + the agent SDK, then a vault created through the factory
 * (global contract) with the TypeScript `FactoryClient`. Skipped (with the
 * reason) when the wasm or the sandbox host binary has not been built:
 * `make build sandbox-node`.
 */
import { JsonRpcProvider, KeyPair, type KeyPairString } from 'near-api-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultCatalog } from '../../demo-api/src/catalog.ts';
import { createApiServer, type ApiServer } from '../../demo-api/src/server.ts';
import {
  AllowanceClient,
  FactoryClient,
  OwnerClient,
  ReceiptVerifier,
  ScriptedPlanner,
  buildPolicy,
  newNonce,
  parseNear,
  requestHash,
  runPaidTask,
  type AllowanceError,
} from '../src/index.ts';
import {
  bootstrapToken,
  bootstrapVault,
  createSandboxAccount,
  deployFactory,
  factoryPrerequisites,
  sandboxPrerequisites,
  startSandboxNode,
  tokenPrerequisites,
  type DemoToken,
  type DemoVault,
  type SandboxNode,
} from '../src/sandbox.ts';

const missing = sandboxPrerequisites() ?? tokenPrerequisites() ?? factoryPrerequisites();
if (missing) console.warn(`[e2e] skipping the sandbox end-to-end test: ${missing}`);

describe.skipIf(missing !== null)('end to end on neard-sandbox', () => {
  let node: SandboxNode;

  beforeAll(async () => {
    node = await startSandboxNode();
  });

  afterAll(async () => {
    await node?.stop();
  });

  describe('a vault deployed on its own account', vaultScenario);
  describe('a vault created by the factory (global contract) with FactoryClient', factoryScenario);

  function vaultScenario(): void {
    let demo: DemoVault;
    let api: ApiServer;
    let apiUrl: string;
    let agent: AllowanceClient;
    let token: DemoToken;

    beforeAll(async () => {
      demo = await bootstrapVault({
        node,
        policy: ({ payeeId }) => buildPolicy({ perTxCap: '1', budget: { amount: '2', period: '1d' }, allow: [payeeId], approvalThreshold: '0.5' }),
      });
      agent = new AllowanceClient({ vaultId: demo.vaultId, rpcUrl: node.rpcUrl, agentKey: demo.agentSecretKey });
      token = await bootstrapToken({
        node,
        demo,
        policy: ({ payeeId, tokenId, decimals }) =>
          buildPolicy({ asset: { ft: tokenId, decimals }, perTxCap: '10', allow: [payeeId], ftStorageDeposit: '0.01' }),
      });
      api = createApiServer({
        payee: demo.payeeId,
        attacker: demo.attackerId,
        catalog: defaultCatalog({ ftToken: token.tokenId, ftDecimals: token.decimals }),
        verifier: new ReceiptVerifier({ rpcUrl: node.rpcUrl, trustedCodeHashes: [demo.codeHash] }),
      });
      apiUrl = await api.listen();
    });

    afterAll(async () => {
      await api?.close();
    });

    it('the agent buys a dataset: 402 -> simulate -> pay with the function-call key -> verified receipt -> 200 -> confirm_delivery', async () => {
      const lines: string[] = [];
      const res = await runPaidTask(
        { name: 'candles', url: `${apiUrl}/dataset`, check: (d) => (d as { data: { rows: unknown[] } }).data.rows.length === 30 },
        { client: agent, planner: new ScriptedPlanner(), log: (l) => lines.push(l) },
      );
      expect(res).toMatchObject({ status: 'delivered', passed: true, paidAmount: parseNear('0.02') });
      const receipt = await agent.receipt((res as { receiptId: number }).receiptId);
      expect(receipt).toMatchObject({ kind: 'pay', status: { status: 'paid' }, payee: demo.payeeId, delivered: true, agent: { key: demo.agentPublicKey } });
    });

    it('a token agent buys a dataset priced in a NEP-141 token: the vault registers the payee and pays with ft_transfer', async () => {
      const usdAgent = new AllowanceClient({ vaultId: demo.vaultId, rpcUrl: node.rpcUrl, agentKey: token.agentSecretKey });
      const res = await runPaidTask(
        { name: 'fx', url: `${apiUrl}/dataset/fx`, check: (d) => (d as { data: { rows: unknown[] } }).data.rows.length === 1440 },
        { client: usdAgent, planner: new ScriptedPlanner(), log: () => {} },
      );
      expect(res).toMatchObject({ status: 'delivered', passed: true, paidAmount: 2_000_000n, asset: { ft: token.tokenId } });
      const receipt = await usdAgent.receipt((res as { receiptId: number }).receiptId);
      expect(receipt).toMatchObject({ status: { status: 'paid' }, asset: { ft: token.tokenId }, amount: '2000000', delivered: true });
      expect(receipt?.storage_deposit).toBe(parseNear('0.01').toString());
      expect((await usdAgent.token(token.tokenId))?.balance).toBe('98000000');
      // The NEAR agent cannot spend the tokens: its policy is in NEAR.
      const sim = await agent.simulate(demo.payeeId, 1n, { asset: { ft: token.tokenId } });
      expect(sim).toMatchObject({ verdict: 'block', reason: { code: 'asset_not_allowed', allowed: 'near' } });
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
      expect(killed.value).toHaveLength(2);
      expect(killed.value).toContainEqual({ key: demo.agentPublicKey });
      expect(killed.value).toContainEqual({ key: token.agentPublicKey });
      const err = (await agent.pay({ payee: demo.payeeId, amount: parseNear('0.01') }).catch((e: unknown) => e)) as AllowanceError;
      expect(err.code).toBe('access_key_not_found');
    });
  }

  function factoryScenario(): void {
    let factoryId: string;
    let codeHash: string;
    const ownerKey = (): KeyPairString => node.rootSecretKey;
    const id = (name: string): string => `${name}.${node.rootAccountId}`;

    beforeAll(async () => {
      ({ factoryId, codeHash } = await deployFactory({ node }));
      await createSandboxAccount(node, id('alice'), '20');
      await createSandboxAccount(node, id('seller'), '1');
    });

    it('create a vault via the factory, fund it, add an agent key, pay, and verify the receipt by global code hash', async () => {
      const factory = new FactoryClient({ factoryId, rpcUrl: node.rpcUrl, signerId: id('alice'), signerKey: ownerKey() });
      const created = await factory.createVault({ name: 'alice', deposit: parseNear('1'), approvalTtlNs: 3_600_000_000_000n });
      expect(created).toMatchObject({ vaultId: `alice.${factoryId}`, created: true, ownerId: id('alice'), codeHash });
      expect(created.events.map((e) => e.event)).toEqual(['vault_created']);

      // The factory lists it; the vault runs the global code and has no access key.
      expect(await factory.vaults()).toEqual([expect.objectContaining({ vault_id: created.vaultId, owner_id: id('alice'), code_hash: codeHash, created_by: id('alice') })]);
      expect((await factory.info()).vaults).toBe(1);
      const provider = new JsonRpcProvider({ url: node.rpcUrl });
      const account = (await provider.viewAccount({ accountId: created.vaultId })) as { global_contract_hash?: string };
      expect(account.global_contract_hash).toBe(codeHash);
      expect((await provider.viewAccessKeyList({ accountId: created.vaultId })).keys).toHaveLength(0);

      // The owner funds it and registers an agent key (the vault adds the key to itself).
      const owner = new OwnerClient({ vaultId: created.vaultId, ownerId: id('alice'), rpcUrl: node.rpcUrl, ownerKey: ownerKey() });
      await owner.deposit(parseNear('2'));
      const agentKey = KeyPair.fromRandom('ed25519');
      const added = await owner.addAgent({ key: agentKey.getPublicKey().toString() }, 'worker', buildPolicy({ perTxCap: '1', allow: [id('seller')], approvalThreshold: '0.5' }));
      expect(added.value).toBe(true);
      expect((await provider.viewAccessKeyList({ accountId: created.vaultId })).keys).toHaveLength(1);

      // The agent pays with its function-call key; the payee verifies by code hash.
      const agent = new AllowanceClient({ vaultId: created.vaultId, rpcUrl: node.rpcUrl, agentKey: agentKey.toString() as KeyPairString });
      const before = BigInt((await provider.viewAccount({ accountId: id('seller') })).amount);
      const nonce = newNonce();
      const paid = await agent.pay({ payee: id('seller'), amount: parseNear('0.1'), memo: 'factory vault', requestHash: requestHash(nonce) });
      expect(paid.outcome).toMatchObject({ outcome: 'paid' });
      const after = BigInt((await provider.viewAccount({ accountId: id('seller') })).amount);
      expect(after - before).toBe(parseNear('0.1'));
      const receiptId = (paid.outcome as { receipt_id: number }).receipt_id;
      const verifier = new ReceiptVerifier({ rpcUrl: node.rpcUrl, trustedCodeHashes: [codeHash] });
      expect(await verifier.verify({ vaultId: created.vaultId, receiptId, payee: id('seller'), minAmount: parseNear('0.1'), nonce })).toMatchObject({ ok: true });
    });

    it('a taken name is refused by the factory before anything is created', async () => {
      const factory = new FactoryClient({ factoryId, rpcUrl: node.rpcUrl, signerId: id('alice'), signerKey: ownerKey() });
      const err = (await factory.createVault({ name: 'alice', deposit: parseNear('1') }).catch((e: unknown) => e)) as AllowanceError;
      expect(err.code).toBe('contract_panic');
      expect(err.message).toMatch(/already exists/);
      expect((await factory.info()).vaults).toBe(1);
    });
  }
});
