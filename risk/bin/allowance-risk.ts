#!/usr/bin/env node
/**
 * allowance-risk <payee...> --rpc <url> [--vault <account>] [--archival-rpc <url>]
 *                [--fastnear-tx <url>] [--deny a,b] [--min-age-days 7] [--code-window-hours 72] [--json]
 *
 * Exit code: 0 allow, 2 warn, 3 block (the worst over all payees), 1 error.
 * Keyless: reads public chain data only.
 */
import { parseArgs } from 'node:util';

import { CounterpartyRisk, riskNote, type RiskReport } from '../src/index.ts';

const USAGE = `allowance-risk <payee...> [options]
  --rpc <url>               NEAR JSON-RPC ($ALLOWANCE_RPC_URL)
  --vault <account>         vault whose denylist and receipts to consult ($ALLOWANCE_VAULT)
  --archival-rpc <url>      node with old blocks for age / code history (default: --rpc)
  --fastnear-tx <url>       FastNear transactions API, e.g. https://tx.main.fastnear.com
  --deny <a,b,...>          extra deny-list ($ALLOWANCE_DENYLIST)
  --min-age-days <n>        warn below this account age (default 7)
  --code-window-hours <n>   warn if the contract changed within this window (default 72)
  --json                    print the full reports`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rpc: { type: 'string' },
    vault: { type: 'string' },
    'archival-rpc': { type: 'string' },
    'fastnear-tx': { type: 'string' },
    deny: { type: 'string' },
    'min-age-days': { type: 'string' },
    'code-window-hours': { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
const env = process.env;
const rpcUrl = values.rpc ?? env['ALLOWANCE_RPC_URL'];
if (values.help || positionals.length === 0 || !rpcUrl) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}
const vaultId = values.vault ?? env['ALLOWANCE_VAULT'];
const deny = (values.deny ?? env['ALLOWANCE_DENYLIST'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const risk = new CounterpartyRisk({
  rpcUrl,
  ...(vaultId ? { vaultId } : {}),
  ...(values['archival-rpc'] ? { archivalRpcUrl: values['archival-rpc'] } : {}),
  ...(values['fastnear-tx'] ? { fastnearTxUrl: values['fastnear-tx'] } : {}),
  ...(values['min-age-days'] ? { minAgeDays: Number(values['min-age-days']) } : {}),
  ...(values['code-window-hours'] ? { codeWindowHours: Number(values['code-window-hours']) } : {}),
  denylist: deny,
});

const reports: RiskReport[] = [];
for (const payee of positionals) reports.push(await risk.assess(payee));
if (values.json) {
  console.log(JSON.stringify(reports, null, 2));
} else {
  for (const r of reports) {
    console.log(`${r.payee}: ${r.verdict.toUpperCase()}  (${riskNote(r)}, ${r.durationMs} ms)`);
    for (const s of r.signals) console.log(`  [${s.level}] ${s.code}: ${s.detail}`);
  }
}
const worst = reports.some((r) => r.verdict === 'block') ? 3 : reports.some((r) => r.verdict === 'warn') ? 2 : 0;
process.exitCode = worst;
