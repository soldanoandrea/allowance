/**
 * Configuration of the testnet demo, from environment variables only. Every
 * account must already exist (the scripts never create accounts). Each key
 * comes either from an environment variable (`TESTNET_OWNER_KEY`, ...;
 * e.g. injected by a password manager's CLI so it never touches the disk)
 * or from a key file the human created (`TESTNET_OWNER_KEY_FILE`, ...).
 * Nothing here writes a key. See docs/TESTNET.md.
 */
import { existsSync } from 'node:fs';

import { isAccountId, parseNear } from '../../sdk/src/index.ts';

export interface TestnetConfig {
  rpcUrl: string;
  ownerId: string;
  /** null: the key is in $TESTNET_OWNER_KEY. */
  ownerKeyFile: string | null;
  vaultId: string;
  /** Full-access key of the vault account: only used to deploy the code. null: $TESTNET_VAULT_KEY. */
  vaultKeyFile: string | null;
  payeeId: string;
  /** null: $TESTNET_AGENT_KEY. */
  agentKeyFile: string | null;
  approverId: string | null;
  depositNear: string;
  policy: { perTxCap: string; budget: string; period: string; approvalThreshold: string };
  /** Archival node for the counterparty-risk check (optional). */
  archivalRpcUrl: string | null;
  denylist: string[];
  apiPort: number;
  autoApprove: boolean;
  confirmed: boolean;
}

export const DEFAULT_TESTNET_RPC = 'https://test.rpc.fastnear.com';

/** Validate `env`; returns the config or the list of problems (nothing is sent either way). */
export function readConfig(env: Record<string, string | undefined>, argv: string[] = []): { config: TestnetConfig | null; problems: string[] } {
  const problems: string[] = [];
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) problems.push(`${name} is not set`);
    return v ?? '';
  };
  const account = (name: string, optional = false): string => {
    const v = optional ? (env[name]?.trim() ?? '') : need(name);
    if (v && !isAccountId(v)) problems.push(`${name}=${v} is not a NEAR account id`);
    else if (v && !v.endsWith('.testnet')) problems.push(`${name}=${v}: only *.testnet accounts are accepted by these scripts`);
    return v;
  };
  /** `<base>` (the key itself, from the environment) or `<base>_FILE` (a path). */
  const key = (base: string): string | null => {
    if (env[base]?.trim()) return null;
    const v = env[`${base}_FILE`]?.trim();
    if (!v) {
      problems.push(`${base} or ${base}_FILE is not set`);
      return null;
    }
    if (!existsSync(v)) problems.push(`${base}_FILE=${v}: file not found`);
    return v;
  };
  const amount = (name: string, fallback: string): string => {
    const v = env[name]?.trim() || fallback;
    try {
      parseNear(v);
    } catch {
      problems.push(`${name}=${v} is not a NEAR amount`);
    }
    return v;
  };

  const rpcUrl = env['TESTNET_RPC_URL']?.trim() || DEFAULT_TESTNET_RPC;
  if (!/testnet|test\.rpc|127\.0\.0\.1|localhost/i.test(rpcUrl) && env['TESTNET_ALLOW_RPC'] !== '1') {
    problems.push(`TESTNET_RPC_URL=${rpcUrl} does not look like a testnet endpoint (set TESTNET_ALLOW_RPC=1 if it is)`);
  }
  if (/mainnet/i.test(rpcUrl)) problems.push(`TESTNET_RPC_URL=${rpcUrl} is a mainnet endpoint: refused`);
  const archival = env['TESTNET_ARCHIVAL_RPC_URL']?.trim() || null;
  if (archival && /mainnet/i.test(archival)) problems.push('TESTNET_ARCHIVAL_RPC_URL is a mainnet endpoint: refused');

  const ownerId = account('TESTNET_OWNER_ID');
  const vaultId = account('TESTNET_VAULT_ID');
  const payeeId = account('TESTNET_PAYEE_ID');
  const approverId = account('TESTNET_APPROVER_ID', true) || null;
  if (vaultId && ownerId && vaultId === ownerId) problems.push('TESTNET_VAULT_ID must be a separate account from TESTNET_OWNER_ID');
  if (vaultId && payeeId && vaultId === payeeId) problems.push('TESTNET_PAYEE_ID must differ from the vault');

  const config: TestnetConfig = {
    rpcUrl,
    ownerId,
    ownerKeyFile: key('TESTNET_OWNER_KEY'),
    vaultId,
    vaultKeyFile: key('TESTNET_VAULT_KEY'),
    payeeId,
    agentKeyFile: key('TESTNET_AGENT_KEY'),
    approverId,
    depositNear: amount('TESTNET_DEPOSIT_NEAR', '2'),
    policy: {
      perTxCap: amount('TESTNET_PER_TX_CAP', '0.5'),
      budget: amount('TESTNET_BUDGET', '1'),
      period: env['TESTNET_BUDGET_PERIOD']?.trim() || '1d',
      approvalThreshold: amount('TESTNET_APPROVAL_THRESHOLD', '0.25'),
    },
    archivalRpcUrl: archival,
    denylist: (env['TESTNET_DENYLIST'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    apiPort: Number(env['TESTNET_API_PORT'] ?? '8402'),
    autoApprove: env['TESTNET_AUTO_APPROVE'] === '1',
    confirmed: env['TESTNET_CONFIRM'] === 'yes' || argv.includes('--yes'),
  };
  if (parseNear(config.policy.approvalThreshold) >= parseNear(config.policy.perTxCap)) {
    problems.push('TESTNET_APPROVAL_THRESHOLD must be below TESTNET_PER_TX_CAP');
  }
  return { config: problems.length ? null : config, problems };
}
