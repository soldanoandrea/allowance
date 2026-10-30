/**
 * One error type for everything the SDK surfaces, with a stable `code` so an
 * agent (or a test) can branch on what went wrong without parsing messages.
 */
export type AllowanceErrorCode =
  /** The key is not on the vault account: removed, rotated, or the vault was killed. */
  | 'access_key_not_found'
  /** The protocol refused the method for this function-call key. */
  | 'method_not_allowed'
  /** Function-call keys cannot attach deposits. */
  | 'deposit_not_allowed'
  /** The key's gas allowance is exhausted (owner: `top_up_allowance`). */
  | 'not_enough_allowance'
  /** The contract panicked (malformed input, unknown agent, owner-only method...). */
  | 'contract_panic'
  /** Missing or invalid configuration (key, vault, RPC URL). */
  | 'config'
  /** Transport-level failure talking to the RPC node. */
  | 'rpc';

export class AllowanceError extends Error {
  readonly code: AllowanceErrorCode;
  readonly txHash: string | undefined;

  constructor(code: AllowanceErrorCode, message: string, options: { cause?: unknown; txHash?: string } = {}) {
    super(message, { cause: options.cause });
    this.name = 'AllowanceError';
    this.code = code;
    this.txHash = options.txHash;
  }
}

const PATTERNS: ReadonlyArray<[RegExp, AllowanceErrorCode, string]> = [
  // From send_tx (AccessKeyNotFound) or, in a fresh process, from the nonce lookup before signing.
  [/AccessKeyNotFound|does not exist on account|Access key \S+ does not exist/i, 'access_key_not_found', 'the agent key is not on the vault account (removed, or the vault was killed)'],
  [/MethodNameMismatch|does not allow method/i, 'method_not_allowed', 'the protocol refused this method for a function-call key'],
  [/DepositWithFunctionCall/i, 'deposit_not_allowed', 'function-call keys cannot attach deposits'],
  [/NotEnoughAllowance/i, 'not_enough_allowance', "the key's gas allowance is exhausted; the owner must call top_up_allowance"],
  [/ContractExecution|Smart contract panicked|FunctionCallError|ExecutionError/i, 'contract_panic', 'the contract refused the call'],
];

/** Map any error thrown by near-api-js (or fetch) onto an `AllowanceError`. */
export function toAllowanceError(err: unknown): AllowanceError {
  if (err instanceof AllowanceError) return err;
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  const txHash = readTxHash(err);
  const haystack = `${name} ${message}`;
  for (const [pattern, code, summary] of PATTERNS) {
    if (pattern.test(haystack)) {
      return new AllowanceError(code, `${summary}: ${message}`, { cause: err, ...(txHash ? { txHash } : {}) });
    }
  }
  return new AllowanceError('rpc', message, { cause: err, ...(txHash ? { txHash } : {}) });
}

function readTxHash(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'txHash' in err) {
    const value = (err as { txHash: unknown }).txHash;
    if (typeof value === 'string') return value;
  }
  return undefined;
}
