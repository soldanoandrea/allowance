/**
 * Exact decimal <-> base-unit conversions on bigint (no floating point):
 * NEAR <-> yoctoNEAR (24 decimals) and any NEP-141 token's decimals.
 */

export const YOCTO_PER_NEAR = 10n ** 24n;
const NEAR_DECIMALS = 24;
const NEAR_AMOUNT = /^(\d+)(?:\.(\d+))?$/;

/** Parse a decimal NEAR amount ("0.02", "5", "1.5") into yoctoNEAR. */
export function parseNear(amount: string): bigint {
  const match = NEAR_AMOUNT.exec(amount.trim());
  if (!match) {
    throw new Error(`invalid NEAR amount ${JSON.stringify(amount)} (expected e.g. "0.02")`);
  }
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > NEAR_DECIMALS) {
    throw new Error(`invalid NEAR amount ${JSON.stringify(amount)}: more than 24 decimals`);
  }
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(fraction.padEnd(NEAR_DECIMALS, '0') || '0');
}

/**
 * Parse an amount given either in NEAR ("0.02", "0.02NEAR", "0.02 NEAR") or
 * in yoctoNEAR with an explicit suffix ("20000000000000000000000yocto").
 */
export function parseAmount(amount: string): bigint {
  const trimmed = amount.trim();
  const yocto = /^(\d+)\s*yocto$/i.exec(trimmed);
  if (yocto) return BigInt(yocto[1] ?? '0');
  return parseNear(trimmed.replace(/\s*near$/i, ''));
}

/** Accept bigint or a decimal yocto string, return bigint. */
export function toYocto(value: bigint | string): bigint {
  if (typeof value === 'bigint') return value;
  if (!/^\d+$/.test(value)) throw new Error(`invalid yoctoNEAR amount ${JSON.stringify(value)}`);
  return BigInt(value);
}

/**
 * Format yoctoNEAR as a NEAR decimal string, trimming trailing zeros and
 * rounding down to `maxDecimals` (default 5). `formatNear(20n * 10n**21n)` -> "0.02".
 */
export function formatNear(value: bigint | string, maxDecimals = 5): string {
  const yocto = toYocto(value);
  const whole = yocto / YOCTO_PER_NEAR;
  const fraction = (yocto % YOCTO_PER_NEAR).toString().padStart(NEAR_DECIMALS, '0');
  const shown = fraction.slice(0, maxDecimals).replace(/0+$/, '');
  if (shown === '' && yocto % YOCTO_PER_NEAR !== 0n && whole === 0n) {
    return `<0.${'0'.repeat(Math.max(0, maxDecimals - 1))}1`;
  }
  return shown ? `${whole}.${shown}` : whole.toString();
}

/** `formatNear` plus the unit: "0.02 NEAR". */
export function near(value: bigint | string, maxDecimals = 5): string {
  return `${formatNear(value, maxDecimals)} NEAR`;
}

/** U64 nanosecond string -> Date (millisecond precision). */
export function nsToDate(ns: string): Date {
  return new Date(Number(BigInt(ns) / 1_000_000n));
}

const DECIMAL_AMOUNT = /^(\d+)(?:\.(\d+))?$/;

/** Parse a decimal amount ("1.5") into base units with `decimals` (e.g. 6 for USDC). */
export function parseUnits(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) throw new Error(`invalid decimals ${decimals}`);
  const match = DECIMAL_AMOUNT.exec(amount.trim());
  if (!match) throw new Error(`invalid amount ${JSON.stringify(amount)} (expected e.g. "1.5")`);
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) throw new Error(`invalid amount ${JSON.stringify(amount)}: more than ${decimals} decimals`);
  return BigInt(match[1] ?? '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/** Format base units with `decimals`, trimming trailing zeros, rounding down to `maxDecimals`. */
export function formatUnits(value: bigint | string, decimals: number, maxDecimals = decimals): string {
  const v = toYocto(value);
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  const fraction = (v % unit).toString().padStart(decimals, '0');
  const shown = fraction.slice(0, maxDecimals).replace(/0+$/, '');
  if (shown === '' && v % unit !== 0n && whole === 0n) return `<0.${'0'.repeat(Math.max(0, maxDecimals - 1))}1`;
  return shown ? `${whole}.${shown}` : whole.toString();
}
