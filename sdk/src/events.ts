import type { AllowanceEvent } from './types.ts';

const PREFIX = 'EVENT_JSON:';

/** Extract the vault's NEP-297 events (standard "allowance") from execution logs. */
export function parseEvents(logs: readonly string[]): AllowanceEvent[] {
  const events: AllowanceEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith(PREFIX)) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(PREFIX.length));
      if (isAllowanceEvent(parsed)) events.push(parsed);
    } catch {
      // Not JSON: some other contract's log line. Ignore it.
    }
  }
  return events;
}

function isAllowanceEvent(value: unknown): value is AllowanceEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['standard'] === 'allowance' &&
    typeof v['event'] === 'string' &&
    typeof v['version'] === 'string' &&
    typeof v['data'] === 'object' &&
    v['data'] !== null
  );
}

/** Minimal shape of an RPC transaction result that carries logs. */
export interface OutcomeWithLogs {
  transaction_outcome?: { outcome: { logs: readonly string[] } };
  receipts_outcome?: ReadonlyArray<{ outcome: { logs: readonly string[] } }>;
}

/** All log lines of a transaction, in execution order. */
export function logsOf(result: OutcomeWithLogs): string[] {
  return [
    ...(result.transaction_outcome?.outcome.logs ?? []),
    ...(result.receipts_outcome ?? []).flatMap((r) => r.outcome.logs),
  ];
}
