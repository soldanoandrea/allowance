import { parseArgs } from 'node:util';

import { CounterpartyRisk, riskPrecheck } from '@allowance/risk';

import { AllowanceClient, LlmPlanner, NEAR_AI_DEFAULT_BASE_URL, ScriptedPlanner, loadKey, type PaidTaskDeps, type Planner } from '../src/index.ts';

export interface ExampleConfig {
  client: AllowanceClient;
  apiUrl: string;
  rpcUrl: string;
  planner: Planner;
  approvalTimeoutMs: number;
  /** `near` (default): the three NEAR datasets; `ft`: the dataset priced in a NEP-141 token. */
  scenario: 'near' | 'ft';
  /** Counterparty-risk check (risk/), unless `--risk off`. */
  risk: CounterpartyRisk | null;
  precheck: PaidTaskDeps['precheck'];
  log: (line: string) => void;
}

const USAGE = `options:
  --vault <account>        vault contract account ($ALLOWANCE_VAULT)
  --rpc <url>              NEAR JSON-RPC endpoint ($ALLOWANCE_RPC_URL)
  --api <url>              paid demo API base URL ($DEMO_API_URL)
  --key-file <path>        agent function-call key file (or $ALLOWANCE_AGENT_KEY)
  --planner scripted|llm   default scripted; llm uses NEAR AI Cloud with $NEAR_AI_API_KEY
  --approval-timeout <s>   how long to wait for the owner (default 120)
  --scenario near|ft       agent loop: NEAR datasets (default) or the NEP-141-priced one
  --risk on|off            counterparty-risk pre-check before simulate (default on)
  --deny <a,b,...>         deny-list for the risk check ($ALLOWANCE_DENYLIST)
  --archival-rpc <url>     node with old blocks for payee age / code history (default --rpc)
  --fastnear-tx <url>      FastNear transactions API for payee age (optional)`;

/** Shared flags of the example agents. The key is read, never written. */
export function exampleConfig(argv: string[], prefix: string): ExampleConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      vault: { type: 'string' },
      rpc: { type: 'string' },
      api: { type: 'string' },
      'key-file': { type: 'string' },
      planner: { type: 'string', default: 'scripted' },
      'approval-timeout': { type: 'string', default: '120' },
      scenario: { type: 'string', default: 'near' },
      risk: { type: 'string', default: 'on' },
      deny: { type: 'string' },
      'archival-rpc': { type: 'string' },
      'fastnear-tx': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const env = process.env;
  const vaultId = values.vault ?? env['ALLOWANCE_VAULT'];
  const rpcUrl = values.rpc ?? env['ALLOWANCE_RPC_URL'];
  const apiUrl = values.api ?? env['DEMO_API_URL'];
  if (!vaultId || !rpcUrl || !apiUrl) {
    console.error(`missing --vault, --rpc or --api\n${USAGE}`);
    process.exit(1);
  }
  const log = (line: string): void => console.log(`${prefix} ${line}`);
  const key = loadKey({ keyFile: values['key-file'] });
  for (const w of key.warnings) log(`warning: ${w}`);
  log(`agent key ${key.publicKey} (from ${key.source}); signs as ${vaultId}, can only call pay / confirm_delivery / ping`);
  const scripted = new ScriptedPlanner();
  let planner: Planner = scripted;
  if (values.planner === 'llm') {
    const apiKey = env['NEAR_AI_API_KEY'];
    if (!apiKey) {
      console.error('--planner llm needs NEAR_AI_API_KEY in the environment (or use --planner scripted)');
      process.exit(1);
    }
    planner = new LlmPlanner({
      apiKey,
      baseUrl: env['NEAR_AI_BASE_URL'] ?? NEAR_AI_DEFAULT_BASE_URL,
      ...(env['NEAR_AI_MODEL'] ? { model: env['NEAR_AI_MODEL'] } : {}),
      fallback: scripted,
      log,
    });
  } else if (values.planner !== 'scripted') {
    console.error(`unknown planner ${JSON.stringify(values.planner)} (scripted | llm)`);
    process.exit(1);
  }
  if (values.scenario !== 'near' && values.scenario !== 'ft') {
    console.error(`unknown scenario ${JSON.stringify(values.scenario)} (near | ft)`);
    process.exit(1);
  }
  let risk: CounterpartyRisk | null = null;
  if (values.risk === 'on') {
    const deny = (values.deny ?? env['ALLOWANCE_DENYLIST'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    risk = new CounterpartyRisk({
      rpcUrl,
      vaultId,
      denylist: deny,
      ...(values['archival-rpc'] ? { archivalRpcUrl: values['archival-rpc'] } : {}),
      ...(values['fastnear-tx'] ? { fastnearTxUrl: values['fastnear-tx'] } : {}),
    });
    log(`counterparty-risk check on (deny-list: ${deny.length ? deny.join(', ') : 'empty'})`);
  } else if (values.risk !== 'off') {
    console.error(`--risk must be on or off`);
    process.exit(1);
  }
  return {
    risk,
    precheck: risk ? riskPrecheck(risk) : undefined,
    scenario: values.scenario,
    client: new AllowanceClient({ vaultId, rpcUrl, agentKey: key.secretKey }),
    apiUrl: apiUrl.replace(/\/$/, ''),
    rpcUrl,
    planner,
    approvalTimeoutMs: Number(values['approval-timeout']) * 1000,
    log,
  };
}
