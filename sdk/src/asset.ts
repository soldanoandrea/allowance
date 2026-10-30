/**
 * Assets: NEAR or a NEP-141 token (`{ ft: "<token contract>" }`).
 *
 * The contract speaks base units only (yoctoNEAR, or the token's smallest
 * unit). For humans the SDK formats and parses decimals: NEAR has 24, a
 * token has whatever its `ft_metadata` says. `AllowanceClient.ftMetadata()`
 * reads it from the chain and registers it here, so later log lines and CLI
 * output show "2 SUSD" instead of "2000000".
 */
import { AllowanceError } from './errors.ts';
import type { Asset } from './types.ts';
import { formatNear, formatUnits, parseAmount, parseUnits } from './units.ts';
import { isAccountId } from './validate.ts';

export const NEAR: Asset = 'near';

export interface TokenDisplay {
  symbol: string;
  decimals: number;
}

const displays = new Map<string, TokenDisplay>();

/** Remember how to show a token (normally from its `ft_metadata`). */
export function setTokenDisplay(tokenId: string, display: TokenDisplay): void {
  displays.set(tokenId, display);
}

export function tokenDisplay(tokenId: string): TokenDisplay | undefined {
  return displays.get(tokenId);
}

export function isNear(asset: Asset | null | undefined): boolean {
  return asset === undefined || asset === null || asset === 'near';
}

/** The token contract of an `ft` asset, or null for NEAR. */
export function tokenOf(asset: Asset | null | undefined): string | null {
  return asset && typeof asset === 'object' && 'ft' in asset ? asset.ft : null;
}

export function sameAsset(a: Asset | null | undefined, b: Asset | null | undefined): boolean {
  return tokenOf(a) === tokenOf(b);
}

/** "near" or "ft:<token>". */
export function assetLabel(asset: Asset | null | undefined): string {
  const token = tokenOf(asset);
  return token === null ? 'near' : `ft:${token}`;
}

/** Parse "near", "ft:usdc.near" (or a bare token account) into an Asset. */
export function parseAsset(text: string): Asset {
  const t = text.trim();
  if (t === '' || t.toLowerCase() === 'near') return 'near';
  const token = t.startsWith('ft:') ? t.slice(3) : t;
  if (!isAccountId(token)) throw new AllowanceError('config', `asset ${JSON.stringify(text)}: expected "near" or "ft:<token account>"`);
  return { ft: token };
}

/** Validate an untrusted asset value (e.g. from a 402 body). */
export function isAsset(value: unknown): value is Asset {
  if (value === 'near') return true;
  if (typeof value !== 'object' || value === null) return false;
  const ft = (value as { ft?: unknown }).ft;
  return typeof ft === 'string' && isAccountId(ft) && Object.keys(value).length === 1;
}

/**
 * "0.02 NEAR", "2.5 SUSD" (token display known), or "2500000 usd.near units"
 * (decimals unknown: base units, never a guess).
 */
export function formatAmount(value: bigint | string, asset: Asset | null | undefined = 'near', maxDecimals?: number): string {
  const token = tokenOf(asset);
  if (token === null) return `${formatNear(value, maxDecimals ?? 5)} NEAR`;
  const display = displays.get(token);
  if (!display) return `${BigInt(value)} ${token} units`;
  return `${formatUnits(value, display.decimals, maxDecimals ?? display.decimals)} ${display.symbol}`;
}

/**
 * Parse a human amount in `asset`: NEAR as in `parseAmount` ("0.02",
 * "5yocto"); a token as a decimal using its registered decimals ("1.5"), or
 * base units with an explicit "units" suffix ("1500000units").
 */
export function parseAssetAmount(text: string, asset: Asset | null | undefined = 'near'): bigint {
  const token = tokenOf(asset);
  if (token === null) return parseAmount(text);
  const trimmed = text.trim();
  const raw = /^(\d+)\s*units?$/i.exec(trimmed);
  if (raw) return BigInt(raw[1] ?? '0');
  const display = displays.get(token);
  if (!display) {
    throw new AllowanceError('config', `decimals of ${token} unknown: read its ft_metadata first, or give base units ("1500000units")`);
  }
  const symbol = display.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return parseUnits(trimmed.replace(new RegExp(`\\s*${symbol}$`, 'i'), ''), display.decimals);
}

/** Decimals of `asset` if known: 24 for NEAR, the registered token display, else null. */
export function assetDecimals(asset: Asset | null | undefined): number | null {
  const token = tokenOf(asset);
  if (token === null) return 24;
  return displays.get(token)?.decimals ?? null;
}

/** "NEAR", the token symbol, or "<token> base units" when its decimals are unknown. */
export function assetUnit(asset: Asset | null | undefined): string {
  const token = tokenOf(asset);
  if (token === null) return 'NEAR';
  return displays.get(token)?.symbol ?? `${token} base units`;
}
