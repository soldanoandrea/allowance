/**
 * Start the paid demo API.
 *
 *   ALLOWANCE_RPC_URL     NEAR JSON-RPC endpoint (required)
 *   API_PAYEE             the API's NEAR account; receipts must pay it (required)
 *   ALLOWANCE_VAULTS      comma-separated vault accounts whose receipts are accepted
 *   ALLOWANCE_CODE_HASHES comma-separated contract code hashes (base58): accept any vault running this code
 *   ATTACKER_ACCOUNT      account named by the poisoned page (attack demo; default attacker.testnet)
 *   VERIFY_FINALITY       final (default) | optimistic
 *   PORT / HOST           default 8402 / 127.0.0.1 (PORT=0 picks a free port)
 *
 * Prints one JSON line {"url": ..., "payee": ...} on stdout when listening;
 * request logs go to stderr.
 */
import { ReceiptVerifier } from '@allowance/sdk';

import { createApiServer } from './server.ts';

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

const env = process.env;
const rpcUrl = env['ALLOWANCE_RPC_URL'];
const payee = env['API_PAYEE'];
if (!rpcUrl || !payee) {
  console.error('demo-api: set ALLOWANCE_RPC_URL and API_PAYEE (see .env.example)');
  process.exit(1);
}
const vaults = list(env['ALLOWANCE_VAULTS']);
const codeHashes = list(env['ALLOWANCE_CODE_HASHES']);
if (vaults.length === 0 && codeHashes.length === 0) {
  console.error('demo-api: set ALLOWANCE_VAULTS and/or ALLOWANCE_CODE_HASHES: which vaults may pay this API?');
  process.exit(1);
}
const finality = env['VERIFY_FINALITY'] === 'optimistic' ? 'optimistic' : 'final';
const verifier = new ReceiptVerifier({ rpcUrl, trustedVaults: vaults, trustedCodeHashes: codeHashes, finality });
const api = createApiServer({
  payee,
  verifier,
  ...(vaults[0] ? { defaultVault: vaults[0] } : {}),
  ...(env['ATTACKER_ACCOUNT'] ? { attacker: env['ATTACKER_ACCOUNT'] } : {}),
  log: (line) => console.error(`[api] ${line}`),
});
const url = await api.listen(Number(env['PORT'] ?? 8402), env['HOST'] ?? '127.0.0.1');
console.log(JSON.stringify({ url, payee }));
console.error(`[api] listening on ${url} as ${payee}; verifying receipts with verify_receipt (${finality})`);

const shutdown = (): void => {
  void api.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
