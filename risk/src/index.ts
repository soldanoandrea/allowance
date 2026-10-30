/**
 * Counterparty-risk check for an Allowance agent (off-chain, keyless).
 *
 * Before an agent even dry-runs a payment (`simulate`), it asks: who is this
 * payee? Signals, all from public data:
 *
 *   - deny-lists: a local/shared list and the vault's own on-chain denylist  -> block
 *   - does the account exist at all                                           -> block if not
 *   - account age: first block the account is seen at, from the FastNear
 *     transactions API (oldest transaction) or by binary search over
 *     `view_account` on an archival RPC node                                 -> warn if young
 *   - contract code: deployed code, and whether its code hash changed in the
 *     last `codeWindowHours` (a payee that just swapped its code)            -> warn
 *   - history in THIS vault: prior receipts to the payee, totals per asset,
 *     failed payments, and deliveries the agents marked as failed
 *     (`confirm_delivery(false)`)                                            -> warn on bad deliveries
 *
 * The verdict is the worst level among the signals: allow / warn / block.
 * The agent refuses on `block`, proceeds on `warn` with the verdict written
 * into the payment memo (the receipt keeps it), and the vault's policy still
 * has the last word on-chain.
 */
import { AllowanceClient, formatAmount, isAccountId, sameAsset, type Asset, type PaymentRequired, type Receipt } from '@allowance/sdk';

import { NO_CODE, Rpc, RpcError, type AccountView, type BlockHeader } from './rpc.ts';

export { NO_CODE, Rpc, RpcError, type AccountView, type BlockHeader, type BlockRef, type RpcErrorKind } from './rpc.ts';

export type RiskVerdict = 'allow' | 'warn' | 'block';
export type SignalLevel = 'info' | 'warn' | 'block';
export type SignalCode =
  | 'invalid_account'
  | 'denylisted'
  | 'vault_denylisted'
  | 'account_missing'
  | 'new_account'
  | 'account_age'
  | 'age_unknown'
  | 'contract_account'
  | 'mutable_code'
  | 'code_changed'
  | 'code_history_unknown'
  | 'first_payment'
  | 'known_payee'
  | 'failed_deliveries'
  | 'failed_payments'
  | 'check_error';

export interface RiskSignal {
  code: SignalCode;
  level: SignalLevel;
  detail: string;
}

export interface AccountFacts {
  exists: boolean;
  /** First block the account is seen at (null: unknown). */
  firstSeenHeight: number | null;
  firstSeenAt: string | null;
  /** The node's history starts after the account appeared: it is at least `ageDays` old. */
  olderThanHistory: boolean;
  ageDays: number | null;
  ageSource: 'fastnear' | 'archival_rpc' | 'none';
  hasCode: boolean;
  /**
   * The code it runs: its own code hash, `global:<hash>` for a global
   * contract used by hash, `global-account:<publisher>` for one used by
   * account id (mutable).
   */
  codeHash: string | null;
  /** Height from which the current code is in place, when it changed inside the window. */
  codeChangedAtHeight: number | null;
  codeChangedAt: string | null;
}

export interface PayeeHistory {
  vaultId: string;
  /** Agent payments to this payee among the receipts read. */
  receipts: number;
  paid: number;
  rejected: number;
  failed: number;
  deliveredOk: number;
  deliveredFailed: number;
  /** Paid totals per asset (base units). */
  totals: Array<{ asset: Asset; amount: string }>;
  /** Receipts read (the newest `maxReceipts`). */
  scanned: number;
}

export interface RiskReport {
  payee: string;
  verdict: RiskVerdict;
  /** One line per warn/block signal. */
  reasons: string[];
  signals: RiskSignal[];
  account: AccountFacts;
  history: PayeeHistory | null;
  checkedAt: string;
  durationMs: number;
}

export interface RiskOptions {
  /** Regular RPC: current state, the vault's views. */
  rpcUrl: string;
  /**
   * Node that keeps old blocks, for account age and code history (default:
   * `rpcUrl`; the local demo sandbox keeps its blocks). A non-archival node
   * answers "older than the node's history" instead of an exact age.
   */
  archivalRpcUrl?: string;
  /**
   * FastNear transactions API base URL (mainnet: https://tx.main.fastnear.com):
   * the account's oldest transaction gives its first block without walking
   * the chain. Optional; falls back to the archival RPC.
   */
  fastnearTxUrl?: string;
  /** The agent's vault: its denylist and its receipts to the payee. */
  vaultId?: string;
  /** Local or shared deny-list (account ids). */
  denylist?: Iterable<string>;
  /** Warn when the payee is younger than this (default 7 days). */
  minAgeDays?: number;
  /** Block when the payee is younger than this (default: never). */
  blockBelowAgeMinutes?: number;
  /** Warn when the payee's contract code changed within this window (default 72 h). */
  codeWindowHours?: number;
  /** Read at most this many of the vault's newest receipts (default 500). */
  maxReceipts?: number;
  /**
   * Reuse the account facts (age, code history: the expensive part) for this
   * long (default 60 s). Deny-lists and the vault history are read every time.
   */
  cacheMs?: number;
  fetchImpl?: typeof fetch;
}

const NS_PER_MS = 1_000_000n;
const DAY_MS = 86_400_000;
/** Heights can be skipped (no block produced): probe this many after a missing one. */
const SKIPPED_HEIGHT_PROBES = 8;

type Presence = 'present' | 'absent' | 'unavailable';
/** Presence at the first produced block at or after the probed height. */
interface Probe {
  presence: Presence;
  height: number;
}

export class CounterpartyRisk {
  readonly #rpc: Rpc;
  readonly #archival: Rpc;
  readonly #options: RiskOptions;
  readonly #denylist: Set<string>;
  readonly #cache = new Map<string, { at: number; account: AccountFacts; signals: RiskSignal[] }>();
  readonly #fetch: typeof fetch;

  constructor(options: RiskOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? ((...args) => fetch(...args));
    this.#rpc = new Rpc(options.rpcUrl, this.#fetch);
    this.#archival = options.archivalRpcUrl ? new Rpc(options.archivalRpcUrl, this.#fetch) : this.#rpc;
    this.#denylist = new Set(options.denylist ?? []);
  }

  /** Assess a payee. Never throws: infrastructure errors become a `check_error` warning. */
  async assess(payee: string): Promise<RiskReport> {
    const started = Date.now();
    const signals: RiskSignal[] = [];
    let account: AccountFacts = {
      exists: false,
      firstSeenHeight: null,
      firstSeenAt: null,
      olderThanHistory: false,
      ageDays: null,
      ageSource: 'none',
      hasCode: false,
      codeHash: null,
      codeChangedAtHeight: null,
      codeChangedAt: null,
    };
    let history: PayeeHistory | null = null;

    if (!isAccountId(payee)) {
      signals.push({ code: 'invalid_account', level: 'block', detail: `${JSON.stringify(payee)} is not a NEAR account id` });
      return this.#finish(payee, signals, account, history, started);
    }
    if (this.#denylist.has(payee)) {
      signals.push({ code: 'denylisted', level: 'block', detail: `${payee} is on the deny-list` });
    }
    await this.#guard(signals, 'vault denylist', async () => {
      if (!this.#options.vaultId) return;
      const list = await this.#rpc.view<string[]>(this.#options.vaultId, 'get_denylist');
      if (Array.isArray(list) && list.includes(payee)) {
        signals.push({ code: 'vault_denylisted', level: 'block', detail: `${payee} is on the vault's on-chain denylist` });
      }
    });

    const cached = this.#cache.get(payee);
    if (cached && Date.now() - cached.at < (this.#options.cacheMs ?? 60_000)) {
      account = cached.account;
      signals.push(...cached.signals);
    } else {
      const accountSignals: RiskSignal[] = [];
      await this.#guard(accountSignals, 'account', async () => {
        const head = await this.#rpc.block();
        const now = await this.#rpc.account(payee);
        if (!now) {
          accountSignals.push({ code: 'account_missing', level: 'block', detail: `account ${payee} does not exist` });
          return;
        }
        account.exists = true;
        account.codeHash = codeIdentity(now);
        account.hasCode = account.codeHash !== NO_CODE;
        await this.#age(payee, head, account, accountSignals);
        if (account.hasCode) {
          accountSignals.push({ code: 'contract_account', level: 'info', detail: `${payee} runs a contract (${describeCode(account.codeHash)})` });
          if (now.global_contract_account_id) {
            accountSignals.push({
              code: 'mutable_code',
              level: 'warn',
              detail: `${payee} runs the global contract published by ${now.global_contract_account_id}, which its publisher can change at any time`,
            });
          }
          await this.#codeHistory(payee, head, account, accountSignals);
        }
      });
      // Only facts about an existing account are worth keeping.
      if (account.exists && !accountSignals.some((s) => s.code === 'check_error')) {
        this.#cache.set(payee, { at: Date.now(), account, signals: accountSignals });
      }
      signals.push(...accountSignals);
    }

    await this.#guard(signals, 'vault history', async () => {
      if (!this.#options.vaultId) return;
      history = await this.#history(this.#options.vaultId, payee);
      if (history.paid === 0) {
        signals.push({ code: 'first_payment', level: 'info', detail: `no paid receipt to ${payee} in ${history.vaultId} yet` });
      } else {
        const totals = history.totals.map((t) => formatAmount(t.amount, t.asset)).join(' + ');
        signals.push({ code: 'known_payee', level: 'info', detail: `${history.paid} paid receipt(s) to ${payee} in ${history.vaultId} (${totals})` });
      }
      if (history.deliveredFailed > 0) {
        signals.push({
          code: 'failed_deliveries',
          level: 'warn',
          detail: `agents marked ${history.deliveredFailed} of ${history.deliveredOk + history.deliveredFailed} deliveries from ${payee} as failed`,
        });
      }
      if (history.failed > 0) {
        signals.push({ code: 'failed_payments', level: 'info', detail: `${history.failed} earlier payment(s) to ${payee} failed` });
      }
    });

    return this.#finish(payee, signals, account, history, started);
  }

  #finish(payee: string, signals: RiskSignal[], account: AccountFacts, history: PayeeHistory | null, started: number): RiskReport {
    const verdict: RiskVerdict = signals.some((s) => s.level === 'block') ? 'block' : signals.some((s) => s.level === 'warn') ? 'warn' : 'allow';
    const report: RiskReport = {
      payee,
      verdict,
      reasons: signals.filter((s) => s.level !== 'info').map((s) => s.detail),
      signals,
      account,
      history,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
    return report;
  }

  async #guard(signals: RiskSignal[], what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      signals.push({ code: 'check_error', level: 'warn', detail: `could not check ${what}: ${(err as Error).message}` });
    }
  }

  // ------------------------------------------------------------------
  // Account age
  // ------------------------------------------------------------------

  async #age(payee: string, head: BlockHeader, account: AccountFacts, signals: RiskSignal[]): Promise<void> {
    let first: { height: number; timestampNs: bigint; olderThanHistory: boolean } | null = null;
    if (this.#options.fastnearTxUrl) {
      first = await this.#firstSeenFastnear(payee).catch(() => null);
      if (first) account.ageSource = 'fastnear';
    }
    if (!first) {
      first = await this.#firstSeenArchival(payee, head);
      if (first) account.ageSource = 'archival_rpc';
    }
    if (!first) {
      signals.push({ code: 'age_unknown', level: 'info', detail: `no history source could date ${payee}` });
      return;
    }
    const ageMs = Number((BigInt(head.timestamp_nanosec) - first.timestampNs) / NS_PER_MS);
    account.firstSeenHeight = first.height;
    account.firstSeenAt = new Date(Number(first.timestampNs / NS_PER_MS)).toISOString();
    account.olderThanHistory = first.olderThanHistory;
    account.ageDays = Math.max(0, ageMs) / DAY_MS;
    const age = describeAge(ageMs, first.olderThanHistory);
    const blockBelow = this.#options.blockBelowAgeMinutes;
    const minAgeDays = this.#options.minAgeDays ?? 7;
    if (!first.olderThanHistory && blockBelow !== undefined && ageMs < blockBelow * 60_000) {
      signals.push({ code: 'new_account', level: 'block', detail: `${payee} is ${age} old (first seen at block ${first.height}); minimum is ${blockBelow} min` });
    } else if (!first.olderThanHistory && ageMs < minAgeDays * DAY_MS) {
      signals.push({ code: 'new_account', level: 'warn', detail: `${payee} is only ${age} old (first seen at block ${first.height})` });
    } else {
      signals.push({ code: 'account_age', level: 'info', detail: `${payee} is ${age} old (first seen at block ${first.height})` });
    }
  }

  /** Oldest transaction of the account in the FastNear transactions API. */
  async #firstSeenFastnear(payee: string): Promise<{ height: number; timestampNs: bigint; olderThanHistory: boolean } | null> {
    const base = (this.#options.fastnearTxUrl ?? '').replace(/\/$/, '');
    const res = await this.#fetch(`${base}/v0/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: payee, limit: 1, desc: false }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { account_txs?: Array<{ tx_block_height?: number; tx_block_timestamp?: number | string }> };
    const row = body.account_txs?.[0];
    if (!row || typeof row.tx_block_height !== 'number' || row.tx_block_timestamp === undefined) return null;
    return { height: row.tx_block_height, timestampNs: BigInt(row.tx_block_timestamp), olderThanHistory: false };
  }

  /**
   * Binary search for the first height at which `view_account` finds the
   * account. Assumes the account was not deleted and recreated in between.
   * On a node without full history the search starts at the oldest block
   * the node still serves and may conclude "older than the history".
   */
  async #firstSeenArchival(payee: string, head: BlockHeader): Promise<{ height: number; timestampNs: bigint; olderThanHistory: boolean } | null> {
    let lo = await this.#archival.genesisHeight();
    let hi = head.height;
    let atLo = await this.#presence(payee, lo, hi);
    if (atLo.presence === 'unavailable') {
      // Find the oldest block the node still serves (availability is monotonic).
      let a = lo;
      let b = hi;
      while (b - a > 1) {
        const mid = Math.floor((a + b) / 2);
        if ((await this.#presence(payee, mid, hi)).presence === 'unavailable') a = mid;
        else b = mid;
      }
      lo = b;
      atLo = await this.#presence(payee, lo, hi);
      if (atLo.presence === 'unavailable') return null;
    }
    if (atLo.presence === 'present') {
      const ts = await this.#timestampAt(atLo.height, hi);
      return ts === null ? null : { height: atLo.height, timestampNs: ts, olderThanHistory: true };
    }
    lo = atLo.height;
    // Invariant: absent at `lo`, present at `hi`; skipped heights hold no state.
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const p = await this.#presence(payee, mid, hi);
      if (p.presence === 'present' && p.height < hi) hi = p.height;
      else if (p.presence === 'present') lo = mid; // mid..hi-1 were all skipped
      else lo = Math.max(mid, Math.min(p.height, hi - 1));
    }
    const ts = await this.#timestampAt(hi, head.height);
    return ts === null ? null : { height: hi, timestampNs: ts, olderThanHistory: false };
  }

  /** Is the account there at `height`? Skipped heights are probed forward (up to `max`). */
  async #presence(payee: string, height: number, max: number): Promise<Probe> {
    for (let h = height; h <= Math.min(max, height + SKIPPED_HEIGHT_PROBES); h++) {
      try {
        return { presence: (await this.#archival.account(payee, { block_id: h })) ? 'present' : 'absent', height: h };
      } catch (err) {
        if (err instanceof RpcError && err.kind === 'unknown_block') continue;
        if (err instanceof RpcError && err.kind === 'unavailable_block') return { presence: 'unavailable', height: h };
        throw err;
      }
    }
    return { presence: 'unavailable', height };
  }

  async #timestampAt(height: number, max: number): Promise<bigint | null> {
    for (let h = height; h <= Math.min(max, height + SKIPPED_HEIGHT_PROBES); h++) {
      try {
        return BigInt((await this.#archival.block({ block_id: h })).timestamp_nanosec);
      } catch (err) {
        if (err instanceof RpcError && err.kind === 'unknown_block') continue;
        return null;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Contract code history
  // ------------------------------------------------------------------

  async #codeHistory(payee: string, head: BlockHeader, account: AccountFacts, signals: RiskSignal[]): Promise<void> {
    const windowHours = this.#options.codeWindowHours ?? 72;
    const current = account.codeHash ?? NO_CODE;
    // Estimate the height `windowHours` ago from the recent block rate.
    const genesis = await this.#archival.genesisHeight();
    const sampleHeight = Math.max(genesis, head.height - 1_000);
    const sampleTs = sampleHeight < head.height ? await this.#timestampAt(sampleHeight, head.height) : null;
    const headTs = BigInt(head.timestamp_nanosec);
    const nsPerBlock = sampleTs !== null && head.height > sampleHeight ? Number(headTs - sampleTs) / (head.height - sampleHeight) : 1e9;
    const windowBlocks = Math.ceil((windowHours * 3_600e9) / Math.max(1, nsPerBlock));
    let baseline = Math.max(genesis, head.height - windowBlocks);
    if (account.firstSeenHeight !== null && account.firstSeenHeight > baseline) baseline = account.firstSeenHeight;

    /** Code hash at the first produced block at or after `h`. */
    const codeAt = async (h: number): Promise<{ code: string | 'unavailable'; height: number }> => {
      for (let x = h; x <= Math.min(head.height, h + SKIPPED_HEIGHT_PROBES); x++) {
        try {
          const view = await this.#archival.account(payee, { block_id: x });
          return { code: view ? codeIdentity(view) : NO_CODE, height: x };
        } catch (err) {
          if (err instanceof RpcError && err.kind === 'unknown_block') continue;
          if (err instanceof RpcError && err.kind === 'unavailable_block') return { code: 'unavailable', height: x };
          throw err;
        }
      }
      return { code: 'unavailable', height: h };
    };

    const before = (await codeAt(baseline)).code;
    if (before === 'unavailable') {
      signals.push({ code: 'code_history_unknown', level: 'info', detail: `the node has no history ${windowHours}h back to check ${payee}'s code` });
      return;
    }
    if (before === current) return;
    // Changed inside the window: find the first height with the current code.
    let lo = baseline;
    let hi = head.height;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const probe = await codeAt(mid);
      if (probe.code === current && probe.height < hi) hi = probe.height;
      else if (probe.code === current) lo = mid; // mid..hi-1 were all skipped
      else lo = Math.max(mid, Math.min(probe.height, hi - 1));
    }
    const ts = await this.#timestampAt(hi, head.height);
    account.codeChangedAtHeight = hi;
    account.codeChangedAt = ts === null ? null : new Date(Number(ts / NS_PER_MS)).toISOString();
    const ago = ts === null ? '' : `, ${describeAge(Number((headTs - ts) / NS_PER_MS), false)} ago`;
    const what = before === NO_CODE ? 'deployed' : 'changed';
    signals.push({ code: 'code_changed', level: 'warn', detail: `${payee}'s contract code was ${what} at block ${hi}${ago} (within ${windowHours}h)` });
  }

  // ------------------------------------------------------------------
  // History in the vault
  // ------------------------------------------------------------------

  async #history(vaultId: string, payee: string): Promise<PayeeHistory> {
    const client = new AllowanceClient({ vaultId, rpcUrl: this.#options.rpcUrl, finality: 'final' });
    const info = await client.vault();
    const max = this.#options.maxReceipts ?? 500;
    const receipts: Receipt[] = await client.receipts({ fromId: Math.max(info.first_receipt_id, info.next_receipt_id - max) });
    const history: PayeeHistory = { vaultId, receipts: 0, paid: 0, rejected: 0, failed: 0, deliveredOk: 0, deliveredFailed: 0, totals: [], scanned: receipts.length };
    for (const r of receipts) {
      if (r.kind !== 'pay' || r.payee !== payee) continue;
      history.receipts++;
      const s = r.status.status;
      if (s === 'rejected') history.rejected++;
      if (s === 'failed') history.failed++;
      if (s === 'paid') {
        history.paid++;
        const asset = r.asset ?? 'near';
        const total = history.totals.find((t) => sameAsset(t.asset, asset));
        if (total) total.amount = (BigInt(total.amount) + BigInt(r.amount)).toString();
        else history.totals.push({ asset, amount: r.amount });
      }
      if (r.delivered === true) history.deliveredOk++;
      if (r.delivered === false) history.deliveredFailed++;
    }
    return history;
  }
}

/** One string per code an account can run (own code, global by hash, global by publisher). */
function codeIdentity(view: AccountView): string {
  if (view.global_contract_hash) return `global:${view.global_contract_hash}`;
  if (view.global_contract_account_id) return `global-account:${view.global_contract_account_id}`;
  return view.code_hash;
}

function describeCode(code: string | null): string {
  if (code?.startsWith('global:')) return `global contract ${code.slice(7)}`;
  if (code?.startsWith('global-account:')) return `global contract of ${code.slice(15)}`;
  return `code hash ${code}`;
}

function describeAge(ms: number, atLeast: boolean): string {
  const prefix = atLeast ? 'at least ' : '';
  if (ms < 3_600_000) return `${prefix}${Math.max(0, Math.round(ms / 60_000))} min`;
  if (ms < 2 * DAY_MS) return `${prefix}${(ms / 3_600_000).toFixed(1)} h`;
  return `${prefix}${Math.floor(ms / DAY_MS)} days`;
}

/**
 * Compact verdict for a payment memo (the receipt keeps it):
 * `risk=warn[new_account,first_payment]`.
 */
export function riskNote(report: RiskReport): string {
  const codes = report.signals.filter((s) => s.level !== 'info' || s.code === 'first_payment').map((s) => s.code);
  return `risk=${report.verdict}${codes.length ? `[${[...new Set(codes)].join(',')}]` : ''}`;
}

/** Adapter for `runPaidTask({ precheck })` in the SDK's agent loop. */
export function riskPrecheck(risk: CounterpartyRisk): (payee: string, quote?: PaymentRequired) => Promise<{ verdict: RiskVerdict; reason?: string; note: string }> {
  return async (payee) => {
    const report = await risk.assess(payee);
    return {
      verdict: report.verdict,
      ...(report.reasons.length ? { reason: report.reasons.join('; ') } : {}),
      note: riskNote(report),
    };
  };
}
