import { parseArgs } from 'node:util';

import { AllowanceClient, LlmPlanner, NEAR_AI_DEFAULT_BASE_URL, ScriptedPlanner, loadKey, type Planner } from '../src/index.ts';

export interface ExampleConfig {
  client: AllowanceClient;
  apiUrl: string;
  rpcUrl: string;
  planner: Planner;
  approvalTimeoutMs: number;
  log: (line: string) => void;
}

const USAGE = `options:
  --vault <account>        vault contract account ($ALLOWANCE_VAULT)
  --rpc <url>              NEAR JSON-RPC endpoint ($ALLOWANCE_RPC_URL)
  --api <url>              paid demo API base URL ($DEMO_API_URL)
  --key-file <path>        agent function-call key file (or $ALLOWANCE_AGENT_KEY)
  --planner scripted|llm   default scripted; llm uses NEAR AI Cloud with $NEAR_AI_API_KEY
  --approval-timeout <s>   how long to wait for the owner (default 120)`;

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
  return {
    client: new AllowanceClient({ vaultId, rpcUrl, agentKey: key.secretKey }),
    apiUrl: apiUrl.replace(/\/$/, ''),
    rpcUrl,
    planner,
    approvalTimeoutMs: Number(values['approval-timeout']) * 1000,
    log,
  };
}
