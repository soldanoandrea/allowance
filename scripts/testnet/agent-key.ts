/**
 * Print a fresh ed25519 key pair for the agent, as near-cli JSON, on stdout.
 * This script writes no file: redirect it yourself, outside the repository,
 * and restrict the permissions, e.g.
 *
 *   umask 077; node scripts/testnet/agent-key.ts vault.you.testnet > ~/.near-credentials/testnet/allowance-agent.json
 *
 * The key is useless until the vault's owner registers it with `add_agent`
 * (scripts/testnet/demo.ts add-agent): it then lives on the vault account as
 * a function-call key limited to pay / confirm_delivery / ping.
 */
import { KeyPair } from 'near-api-js';

const vaultId = process.argv[2];
if (!vaultId) {
  console.error('usage: node scripts/testnet/agent-key.ts <vault account id>  > <key file outside the repo>');
  process.exit(1);
}
const key = KeyPair.fromRandom('ed25519');
console.log(JSON.stringify({ account_id: vaultId, public_key: key.getPublicKey().toString(), private_key: key.toString() }, null, 2));
console.error(`agent public key: ${key.getPublicKey().toString()} (register it with: node scripts/testnet/demo.ts add-agent)`);
