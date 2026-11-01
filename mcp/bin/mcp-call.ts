#!/usr/bin/env node
/**
 * mcp-call <tool> [json arguments] -- [allowance-mcp options]
 *
 * A minimal MCP client for trying the server from a shell: it starts
 * mcp/bin/allowance-mcp.ts over stdio (as Claude Desktop would), calls one
 * tool and prints the answer. Exit 0, or 3 if the tool answered with an error
 * (a refusal included).
 *
 *   node mcp/bin/mcp-call.ts allowance_pay '{"payee":"attacker.sandbox","amount":"1"}' -- --key-file agent.json
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const [tool, json] = sep === -1 ? argv : argv.slice(0, sep);
const serverArgs = sep === -1 ? [] : argv.slice(sep + 1);
if (!tool) {
  console.error('usage: mcp-call <tool> [json arguments] -- [allowance-mcp options]   (tool "list" lists the tools)');
  process.exit(1);
}

const client = new Client({ name: 'mcp-call', version: '0.1.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(dirname(fileURLToPath(import.meta.url)), 'allowance-mcp.ts'), ...serverArgs],
    env: process.env as Record<string, string>,
  }),
);
try {
  if (tool === 'list') {
    for (const t of (await client.listTools()).tools) console.log(`${t.name}: ${t.description ?? ''}`);
  } else {
    const r = await client.callTool({ name: tool, arguments: json ? (JSON.parse(json) as Record<string, unknown>) : {} });
    for (const c of r.content as Array<{ type: string; text?: string }>) if (c.text) console.log(c.text);
    if (r.isError) process.exitCode = 3;
  }
} finally {
  await client.close();
}
