#!/usr/bin/env node
/**
 * allowance-mcp: the Allowance tools over MCP stdio.
 *
 *   allowance-mcp --vault <account> --rpc <url> [--key-file <path>] [--deny a,b]
 *                 [--archival-rpc <url>] [--fastnear-tx <url>] [--no-risk]
 *
 * The agent key comes from --key-file or $ALLOWANCE_AGENT_KEY (best: injected
 * by a password manager into the MCP client's environment). The server only
 * reads it. stdout carries the MCP protocol; diagnostics go to stderr.
 *
 * Claude Desktop / Claude Code configuration:
 *   { "mcpServers": { "allowance": { "command": "node",
 *       "args": ["mcp/bin/allowance-mcp.ts", "--vault", "vault.you.testnet", "--rpc", "https://rpc.testnet.near.org"],
 *       "env": { "ALLOWANCE_AGENT_KEY": "ed25519:..." } } } }
 */
import { parseArgs } from 'node:util';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { CounterpartyRisk, riskPrecheck } from '@allowance/risk';
import { AllowanceClient, loadKey, shortKey } from '@allowance/sdk';

import { AllowanceTools, createServer } from '../src/index.ts';

const USAGE = `allowance-mcp [options]   (MCP server on stdio)
  --vault <account>         the vault ($ALLOWANCE_VAULT)
  --rpc <url>               NEAR JSON-RPC ($ALLOWANCE_RPC_URL)
  --key-file <path>         the agent's function-call key (default: $ALLOWANCE_AGENT_KEY)
  --deny <a,b,...>          deny-list for the counterparty check ($ALLOWANCE_DENYLIST)
  --archival-rpc <url>      node with old blocks for account age (default: --rpc)
  --fastnear-tx <url>       FastNear transactions API, e.g. https://tx.main.fastnear.com
  --no-risk                 skip the counterparty check (the vault policy still applies)`;

const { values } = parseArgs({
  options: {
    vault: { type: 'string' },
    rpc: { type: 'string' },
    'key-file': { type: 'string' },
    deny: { type: 'string' },
    'archival-rpc': { type: 'string' },
    'fastnear-tx': { type: 'string' },
    'no-risk': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
const env = process.env;
const vaultId = values.vault ?? env['ALLOWANCE_VAULT'];
const rpcUrl = values.rpc ?? env['ALLOWANCE_RPC_URL'];
if (values.help || !vaultId || !rpcUrl) {
  console.error(USAGE);
  process.exit(values.help ? 0 : 1);
}
const log = (line: string): void => console.error(`[allowance-mcp] ${line}`);

const key = loadKey({ keyFile: values['key-file'], env });
for (const w of key.warnings) log(`warning: ${w}`);
const client = new AllowanceClient({ vaultId, rpcUrl, agentKey: key.secretKey });
const deny = (values.deny ?? env['ALLOWANCE_DENYLIST'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const precheck = values['no-risk']
  ? undefined
  : riskPrecheck(
      new CounterpartyRisk({
        rpcUrl,
        vaultId,
        denylist: deny,
        ...(values['archival-rpc'] ? { archivalRpcUrl: values['archival-rpc'] } : {}),
        ...(values['fastnear-tx'] ? { fastnearTxUrl: values['fastnear-tx'] } : {}),
      }),
    );

const server = createServer(new AllowanceTools({ client, ...(precheck ? { precheck } : {}), log }));
await server.connect(new StdioServerTransport());
log(`serving vault ${vaultId} as agent ${shortKey(key.publicKey)} (key from ${key.source})${precheck ? `, counterparty check on (${deny.length} deny-listed)` : ''}`);
