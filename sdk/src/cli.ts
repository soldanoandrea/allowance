/**
 * `allowance` command-line interface.
 *
 * The agent key comes from `--key-file <path>` (given explicitly) or the
 * ALLOWANCE_AGENT_KEY environment variable; owner commands (and `factory
 * create`, signed by the future owner) use `--owner-key-file` or
 * ALLOWANCE_OWNER_KEY. The CLI never writes keys.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { guardedPay, logPayResult, logSimulation } from './agent/guarded-pay.ts';
import { formatAmount, isNear, parseAsset, parseAssetAmount, tokenDisplay, tokenOf } from './asset.ts';
import { AllowanceClient } from './client.ts';
import { describeAgent, describePolicy, describeRejection, describeStatus, iso, shortKey } from './describe.ts';
import { AllowanceError } from './errors.ts';
import { table } from './format.ts';
import { FactoryClient } from './factory.ts';
import { requestHash } from './hash.ts';
import { AGENT_KEY_ENV, OWNER_KEY_ENV, loadKey } from './keys.ts';
import { OwnerClient } from './owner.ts';
import { parseDuration } from './policy.ts';
import type { AgentId, Asset, Receipt } from './types.ts';
import { near, parseAmount } from './units.ts';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  /** Terminal width, when output goes to a terminal: tables are fitted to it. */
  columns?: number | undefined;
}

/** Exit codes: 0 ok, 1 error, 2 waiting for human approval, 3 refused / rejected by the policy. */
export const EXIT = { ok: 0, error: 1, needsApproval: 2, refused: 3 } as const;

const USAGE = `allowance <command> [options]

Agent (signs with the function-call key: --key-file <path> or $${AGENT_KEY_ENV})
  simulate --payee <account> --amount <amount>   free dry-run: allow | needs_approval | block
  pay      --payee <account> --amount <amount> [--memo <text>] [--nonce <n> | --request-hash <b64>]
           [--force]                             simulate first and refuse on block (--force: sign anyway)
  confirm  --receipt <id> --passed <true|false>  record whether the purchase was delivered
  ping                                           how the vault identifies this key

Read-only (no key needed)
  receipts [--from <id>] [--limit <n>]           receipts table
  ledger                                         vault, agents and policies, approvals, recent receipts
  verify   --receipt <id> --payee <account> --amount <amount> [--nonce <n>]

Owner / approver (--owner <account>, key: --owner-key-file <path> or $${OWNER_KEY_ENV})
  approve <pending id>    deny <pending id>    kill

Factory (--factory <account> or $ALLOWANCE_FACTORY; vaults on one global contract)
  factory create --name <label> --owner <account> [--approver <account>] [--deposit <NEAR>]
                 [--approval-ttl <1d>] [--key-gas-allowance <NEAR>] [--signer <account>]
                                                 create <label>.<factory>; signed by --signer (default
                                                 --owner) with --owner-key-file or $${OWNER_KEY_ENV}
  factory list [--from <index>] [--limit <n>]    vaults the factory created
  factory info                                   factory owner, vault code hash, minimum deposit

Common options
  --vault <account>   vault contract account   ($ALLOWANCE_VAULT)
  --rpc <url>         NEAR JSON-RPC endpoint    ($ALLOWANCE_RPC_URL)
  --agent <ed25519:pk> simulate for this agent key without holding it
  --asset near|ft:<token>  asset of simulate / pay / verify (default near; NEP-141 token by contract)
  --json              machine-readable output
Amounts are NEAR ("0.02", or "...yocto"), or for --asset ft:<token> a decimal in the
token's units ("1.5", decimals read from its ft_metadata) or base units ("1500000units").`;

const OPTIONS = {
  vault: { type: 'string' },
  rpc: { type: 'string' },
  'key-file': { type: 'string' },
  'owner-key-file': { type: 'string' },
  owner: { type: 'string' },
  agent: { type: 'string' },
  factory: { type: 'string' },
  name: { type: 'string' },
  signer: { type: 'string' },
  approver: { type: 'string' },
  deposit: { type: 'string' },
  'approval-ttl': { type: 'string' },
  'key-gas-allowance': { type: 'string' },
  payee: { type: 'string' },
  amount: { type: 'string' },
  asset: { type: 'string' },
  memo: { type: 'string' },
  nonce: { type: 'string' },
  'request-hash': { type: 'string' },
  receipt: { type: 'string' },
  passed: { type: 'string' },
  from: { type: 'string' },
  limit: { type: 'string' },
  force: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

type Values = ReturnType<typeof parse>['values'];

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    io.err(`${(err as Error).message}\n\n${USAGE}`);
    return EXIT.error;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    io.out(USAGE);
    return values.help ? EXIT.ok : EXIT.error;
  }
  try {
    switch (command) {
      case 'simulate':
        return await simulate(values, io);
      case 'pay':
        return await pay(values, io);
      case 'confirm':
        return await confirm(values, io);
      case 'ping':
        return await ping(values, io);
      case 'receipts':
        return await receipts(values, io);
      case 'ledger':
        return await ledger(values, io);
      case 'verify':
        return await verify(values, io);
      case 'approve':
      case 'deny':
        return await decide(command, rest[0], values, io);
      case 'kill':
        return await kill(values, io);
      case 'factory':
        return await factory(rest[0], values, io);
      default:
        io.err(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
        return EXIT.error;
    }
  } catch (err) {
    const e = err instanceof AllowanceError ? err : null;
    io.err(`error${e ? ` [${e.code}]` : ''}: ${(err as Error).message}`);
    return EXIT.error;
  }
}

// ----------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------

function required(value: string | undefined, what: string): string {
  if (!value) throw new AllowanceError('config', `missing ${what}`);
  return value;
}

function target(values: Values, io: CliIo): { vaultId: string; rpcUrl: string } {
  return {
    vaultId: required(values.vault ?? io.env['ALLOWANCE_VAULT'], '--vault (or $ALLOWANCE_VAULT)'),
    rpcUrl: required(values.rpc ?? io.env['ALLOWANCE_RPC_URL'], '--rpc (or $ALLOWANCE_RPC_URL)'),
  };
}

function readClient(values: Values, io: CliIo): AllowanceClient {
  return new AllowanceClient(target(values, io));
}

function agentClient(values: Values, io: CliIo): AllowanceClient {
  const key = loadKey({ keyFile: values['key-file'], envVar: AGENT_KEY_ENV, env: io.env });
  for (const w of key.warnings) io.err(`warning: ${w}`);
  return new AllowanceClient({ ...target(values, io), agentKey: key.secretKey });
}

function ownerClient(values: Values, io: CliIo): OwnerClient {
  const key = loadKey({ keyFile: values['owner-key-file'], envVar: OWNER_KEY_ENV, env: io.env });
  for (const w of key.warnings) io.err(`warning: ${w}`);
  const ownerId = required(values.owner ?? io.env['ALLOWANCE_OWNER'], '--owner (or $ALLOWANCE_OWNER)');
  return new OwnerClient({ ...target(values, io), ownerId, ownerKey: key.secretKey });
}

function assetOf(values: Values): Asset {
  return parseAsset(values.asset ?? 'near');
}

/** Read symbol and decimals of the tokens in `assets` once (for parsing and display). */
async function learnTokens(client: AllowanceClient, assets: Array<Asset | null | undefined>): Promise<void> {
  const tokens = new Set(assets.map(tokenOf).filter((t): t is string => t !== null && !tokenDisplay(t)));
  await Promise.all([...tokens].map((t) => client.ftMetadata(t).catch(() => undefined)));
}

async function amountOf(values: Values, client: AllowanceClient, asset: Asset): Promise<bigint> {
  await learnTokens(client, [asset]);
  return parseAssetAmount(required(values.amount, '--amount'), asset);
}

function assetOpt(asset: Asset): { asset?: Asset } {
  return isNear(asset) ? {} : { asset };
}

function intOf(value: string | undefined, what: string): number {
  const text = required(value, what);
  if (!/^\d+$/.test(text)) throw new AllowanceError('config', `${what} must be a non-negative integer`);
  return Number(text);
}

function print(io: CliIo, values: Values, json: unknown, text: () => string): void {
  io.out(values.json ? JSON.stringify(json, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2) : text());
}

// ----------------------------------------------------------------------
// Commands
// ----------------------------------------------------------------------

async function simulate(values: Values, io: CliIo): Promise<number> {
  const payee = required(values.payee, '--payee');
  const asset = assetOf(values);
  let client: AllowanceClient;
  let agentId: AgentId | undefined;
  if (values.agent) {
    client = readClient(values, io);
    agentId = { key: values.agent };
  } else {
    client = agentClient(values, io);
  }
  const amount = await amountOf(values, client, asset);
  const sim = await client.simulate(payee, amount, { ...(agentId ? { agentId } : {}), ...assetOpt(asset) });
  print(io, values, sim, () => {
    const lines: string[] = [];
    logSimulation((l) => lines.push(l), payee, amount, sim, asset);
    return lines.join('\n');
  });
  return sim.verdict === 'block' ? EXIT.refused : sim.verdict === 'needs_approval' ? EXIT.needsApproval : EXIT.ok;
}

async function pay(values: Values, io: CliIo): Promise<number> {
  const client = agentClient(values, io);
  const payee = required(values.payee, '--payee');
  const asset = assetOf(values);
  const amount = await amountOf(values, client, asset);
  const hash = values['request-hash'] ?? (values.nonce ? requestHash(values.nonce) : undefined);
  const request = {
    payee,
    amount,
    ...assetOpt(asset),
    ...(values.memo !== undefined ? { memo: values.memo } : {}),
    ...(hash !== undefined ? { requestHash: hash } : {}),
  };
  const lines: string[] = [];
  const log = (l: string): void => {
    lines.push(l);
    if (!values.json) io.out(l);
  };
  let outcomeJson: unknown;
  let code: number = EXIT.ok;
  if (values.force) {
    log('--force: skipping the simulate guard, the contract decides on-chain');
    const result = await client.pay(request);
    logPayResult(log, result, asset);
    outcomeJson = result;
    code = exitFor(result.outcome.outcome);
  } else {
    const guarded = await guardedPay(client, request, log);
    if (guarded.status === 'refused') {
      outcomeJson = { refused: guarded.reason, simulation: guarded.simulation };
      code = EXIT.refused;
    } else {
      outcomeJson = guarded.result;
      code = exitFor(guarded.result.outcome.outcome);
    }
  }
  if (values.json) print(io, values, outcomeJson, () => '');
  return code;
}

function exitFor(outcome: string): number {
  if (outcome === 'needs_approval') return EXIT.needsApproval;
  if (outcome === 'rejected') return EXIT.refused;
  if (outcome === 'paid') return EXIT.ok;
  return EXIT.error;
}

async function confirm(values: Values, io: CliIo): Promise<number> {
  const client = agentClient(values, io);
  const receiptId = intOf(values.receipt, '--receipt');
  const passedText = required(values.passed, '--passed');
  if (passedText !== 'true' && passedText !== 'false') throw new AllowanceError('config', '--passed must be true or false');
  const tx = await client.confirmDelivery(receiptId, passedText === 'true');
  print(io, values, tx, () => `confirm_delivery(#${receiptId}, ${passedText}) tx ${tx.txHash}`);
  return EXIT.ok;
}

async function ping(values: Values, io: CliIo): Promise<number> {
  const client = agentClient(values, io);
  const res = await client.ping();
  print(io, values, res, () =>
    `${describeAgent(res.agent)}: ${res.registered ? `registered as "${res.label}"` : 'NOT registered'}, ` +
    `${res.active ? 'active' : 'inactive'}, vault ${res.paused ? 'PAUSED' : 'running'} (tx ${res.txHash})`,
  );
  return EXIT.ok;
}

function receiptRows(list: Receipt[]): string[][] {
  return list.map((r) => [
    `#${r.id}`,
    r.kind,
    describeStatus(r.status),
    describeAgent(r.agent),
    r.payee,
    formatAmount(r.amount, r.asset),
    r.delivered === null ? '' : r.delivered ? 'pass' : 'FAIL',
    r.memo.length > 40 ? `${r.memo.slice(0, 39)}~` : r.memo,
  ]);
}

const RECEIPT_HEADERS = ['id', 'kind', 'status', 'agent', 'payee', 'amount', 'delivered', 'memo'];

async function receipts(values: Values, io: CliIo): Promise<number> {
  const client = readClient(values, io);
  const list = await client.receipts({
    ...(values.from !== undefined ? { fromId: intOf(values.from, '--from') } : {}),
    ...(values.limit !== undefined ? { limit: intOf(values.limit, '--limit') } : {}),
  });
  await learnTokens(client, list.map((r) => r.asset));
  print(io, values, list, () => (list.length ? table(RECEIPT_HEADERS, receiptRows(list), io.columns) : 'no receipts'));
  return EXIT.ok;
}

/** file:// URL of the static ledger page for this vault. */
export function ledgerUrl(rpcUrl: string, vaultId: string): string {
  const page = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'ledger', 'index.html');
  const url = pathToFileURL(page);
  url.searchParams.set('rpc', rpcUrl);
  url.searchParams.set('vault', vaultId);
  return url.toString();
}

async function ledger(values: Values, io: CliIo): Promise<number> {
  const { vaultId, rpcUrl } = target(values, io);
  const client = readClient(values, io);
  const [info, agents, pending] = await Promise.all([client.vault(), client.agents(), client.pending()]);
  const recent = await client.receipts({ fromId: Math.max(info.first_receipt_id, info.next_receipt_id - 10), limit: 10 });
  await learnTokens(client, [
    ...info.tokens.map((t): Asset => ({ ft: t.token_id })),
    ...agents.map((a) => a.policy.asset),
    ...recent.map((r) => r.asset),
  ]);
  print(io, values, { vault: info, agents, pending, receipts: recent, ledger_url: ledgerUrl(rpcUrl, vaultId) }, () => {
    const out = [
      `vault ${vaultId}  owner ${info.owner_id}${info.approver_id ? `  approver ${info.approver_id}` : ''}  ${info.paused ? 'PAUSED' : 'running'}`,
      `balance ${near(info.balance)}  available ${near(info.available)}  receipts ${info.next_receipt_id}  pending ${info.pending}`,
      ...info.tokens.map((t) => `token ${t.token_id}: ${formatAmount(t.balance, { ft: t.token_id })} accounted by the vault`),
      ...(info.split ? [`revenue split: ${info.split.beneficiaries.map((b) => `${b.account_id} ${b.bps / 100}%`).join(', ')} of every income`] : []),
      '',
      `agents (${agents.length})`,
    ];
    for (const a of agents) {
      const remaining = a.remaining_budget === null ? '' : `, ${formatAmount(a.remaining_budget, a.policy.asset)} left in window`;
      const status = a.active
        ? 'active'
        : a.auto_disabled
          ? `DISABLED by the vault after receipt #${a.auto_disabled.receipt_id} (${describeRejection(a.auto_disabled.reason, a.policy.asset)}; ${a.auto_disabled.consecutive_rejections} rejected in a row), re-enable with enable_agent`
          : 'DISABLED';
      out.push(`  ${describeAgent(a.id)} "${a.label}" ${status}, policy v${a.policy_version}, ${a.state.payments} payment${a.state.payments === 1 ? '' : 's'}${remaining}`);
      for (const line of describePolicy(a.policy)) out.push(`    - ${line}`);
    }
    out.push('', `pending approvals (${pending.length})`);
    for (const p of pending) {
      out.push(`  #${p.id} receipt #${p.receipt_id}: ${formatAmount(p.amount, p.asset)} -> ${p.payee} "${p.memo}" (expires ${iso(p.expires_at_ns)})`);
    }
    out.push('', 'recent receipts', recent.length ? table(RECEIPT_HEADERS, receiptRows(recent), io.columns) : 'no receipts');
    out.push('', `ledger page: ${ledgerUrl(rpcUrl, vaultId)}`);
    return out.join('\n');
  });
  return EXIT.ok;
}

async function verify(values: Values, io: CliIo): Promise<number> {
  const client = readClient(values, io);
  const receiptId = intOf(values.receipt, '--receipt');
  const asset = assetOf(values);
  const ok = await client.verifyReceipt({
    receiptId,
    payee: required(values.payee, '--payee'),
    minAmount: await amountOf(values, client, asset),
    ...(values.nonce ? { requestHash: requestHash(values.nonce) } : {}),
    ...assetOpt(asset),
  });
  print(io, values, { receipt_id: receiptId, verified: ok }, () => `receipt #${receiptId}: ${ok ? 'VERIFIED' : 'not valid for this payee/amount/request'}`);
  return ok ? EXIT.ok : EXIT.refused;
}

async function decide(command: 'approve' | 'deny', idText: string | undefined, values: Values, io: CliIo): Promise<number> {
  const owner = ownerClient(values, io);
  const pendingId = intOf(idText, `${command} <pending id>`);
  // The contract forgets a request once it is approved, denied or expired:
  // say so instead of surfacing its bare "unknown pending id" panic.
  const closed = (err: unknown): never => {
    if (err instanceof AllowanceError && /unknown pending id/.test(err.message)) {
      throw new AllowanceError(
        'contract_panic',
        `no open approval request #${pendingId} (already approved, denied or expired, or never created); list the open ones with \`allowance ledger\``,
        { cause: err },
      );
    }
    throw err;
  };
  if (command === 'deny') {
    const tx = await owner.deny(pendingId).catch(closed);
    print(io, values, tx, () => `denied approval request #${pendingId} (tx ${tx.txHash})`);
    return EXIT.ok;
  }
  const tx = await owner.approve(pendingId).catch(closed);
  const o = tx.value;
  print(io, values, tx, () =>
    `approve #${pendingId}: ${o.outcome} (receipt #${o.receipt_id})${o.outcome === 'rejected' ? ` - ${describeRejection(o.reason)}` : ''} (tx ${tx.txHash})`,
  );
  return o.outcome === 'paid' ? EXIT.ok : EXIT.refused;
}

async function kill(values: Values, io: CliIo): Promise<number> {
  const owner = ownerClient(values, io);
  const tx = await owner.kill();
  print(io, values, tx, () =>
    `vault killed: paused, ${tx.value.length} agent key(s) deleted at the protocol level (tx ${tx.txHash})\n` +
    tx.value.map((a) => `  - ${describeAgent(a)}`).join('\n'),
  );
  return EXIT.ok;
}

// ----------------------------------------------------------------------
// Factory
// ----------------------------------------------------------------------

function factoryTarget(values: Values, io: CliIo): { factoryId: string; rpcUrl: string } {
  return {
    factoryId: required(values.factory ?? io.env['ALLOWANCE_FACTORY'], '--factory (or $ALLOWANCE_FACTORY)'),
    rpcUrl: required(values.rpc ?? io.env['ALLOWANCE_RPC_URL'], '--rpc (or $ALLOWANCE_RPC_URL)'),
  };
}

async function factory(sub: string | undefined, values: Values, io: CliIo): Promise<number> {
  switch (sub) {
    case 'create':
      return factoryCreate(values, io);
    case 'list':
      return factoryList(values, io);
    case 'info':
      return factoryInfo(values, io);
    default:
      io.err(`unknown factory command ${JSON.stringify(sub ?? '')}: use create, list or info\n\n${USAGE}`);
      return EXIT.error;
  }
}

async function factoryCreate(values: Values, io: CliIo): Promise<number> {
  const { factoryId, rpcUrl } = factoryTarget(values, io);
  const name = required(values.name, '--name');
  const ownerId = values.owner ?? io.env['ALLOWANCE_OWNER'];
  const signerId = required(values.signer ?? ownerId, '--owner or --signer (or $ALLOWANCE_OWNER)');
  const key = loadKey({ keyFile: values['owner-key-file'], envVar: OWNER_KEY_ENV, env: io.env });
  for (const w of key.warnings) io.err(`warning: ${w}`);
  const client = new FactoryClient({ factoryId, rpcUrl, signerId, signerKey: key.secretKey });
  const res = await client.createVault({
    name,
    ...(ownerId ? { ownerId } : {}),
    ...(values.approver ? { approverId: values.approver } : {}),
    ...(values.deposit ? { deposit: parseAmount(values.deposit) } : {}),
    ...(values['approval-ttl'] ? { approvalTtlNs: parseDuration(values['approval-ttl']) } : {}),
    ...(values['key-gas-allowance'] ? { keyGasAllowance: parseAmount(values['key-gas-allowance']) } : {}),
  });
  print(io, values, res, () =>
    res.created
      ? [
          `created vault ${res.vaultId}: owner ${res.ownerId}, balance ${near(res.deposit)}, code ${res.codeHash ?? '?'} (global contract) (tx ${res.txHash})`,
          `  it has no access key: ${res.ownerId} manages it (deposit, add_agent, approve, kill); agent keys are added by the vault itself`,
          `  npx allowance ledger --vault ${res.vaultId} --rpc ${rpcUrl}`,
        ].join('\n')
      : `vault ${res.vaultId} was NOT created; the factory refunded ${near(res.deposit)} to ${signerId} (tx ${res.txHash})`,
  );
  return res.created ? EXIT.ok : EXIT.error;
}

async function factoryList(values: Values, io: CliIo): Promise<number> {
  const client = new FactoryClient(factoryTarget(values, io));
  const list = await client.vaults({
    ...(values.from !== undefined ? { fromIndex: intOf(values.from, '--from') } : {}),
    ...(values.limit !== undefined ? { limit: intOf(values.limit, '--limit') } : {}),
  });
  print(io, values, list, () =>
    list.length
      ? table(
          ['vault', 'owner', 'created by', 'created at', 'code'],
          list.map((v) => [v.vault_id, v.owner_id, v.created_by, iso(v.created_at_ns), shortKey(v.code_hash)]),
        )
      : 'no vaults yet',
  );
  return EXIT.ok;
}

async function factoryInfo(values: Values, io: CliIo): Promise<number> {
  const { factoryId, rpcUrl } = factoryTarget(values, io);
  const info = await new FactoryClient({ factoryId, rpcUrl }).info();
  print(io, values, info, () =>
    [
      `factory ${factoryId}  owner ${info.owner_id}  vaults ${info.vaults}`,
      `vault code (global contract by hash, immutable): ${info.vault_code_hash}`,
      `minimum deposit per vault: ${near(info.min_deposit)}`,
    ].join('\n'),
  );
  return EXIT.ok;
}
