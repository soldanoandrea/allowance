import { describe, expect, it } from 'vitest';

import { formatNear, near, nsToDate, parseAmount, parseNear, toYocto } from '../src/units.ts';

describe('NEAR units', () => {
  it('parses decimal NEAR exactly', () => {
    expect(parseNear('0.02')).toBe(20_000_000_000_000_000_000_000n);
    expect(parseNear('5')).toBe(5n * 10n ** 24n);
    expect(parseNear('0.000000000000000000000001')).toBe(1n);
    expect(parseNear(' 1.5 ')).toBe(15n * 10n ** 23n);
  });

  it('rejects malformed amounts', () => {
    for (const bad of ['', '-1', '1e3', '0.1.2', 'abc', '0.0000000000000000000000001']) {
      expect(() => parseNear(bad), bad).toThrow();
    }
  });

  it('parses NEAR or explicit yocto amounts', () => {
    expect(parseAmount('0.02 NEAR')).toBe(parseNear('0.02'));
    expect(parseAmount('0.02near')).toBe(parseNear('0.02'));
    expect(parseAmount('123yocto')).toBe(123n);
  });

  it('formats yocto as NEAR, trimming and rounding down', () => {
    expect(formatNear(parseNear('0.02'))).toBe('0.02');
    expect(formatNear('5000000000000000000000000')).toBe('5');
    expect(formatNear(parseNear('1.234567'), 3)).toBe('1.234');
    expect(formatNear(1n)).toBe('<0.00001');
    expect(near(parseNear('0.5'))).toBe('0.5 NEAR');
  });

  it('validates yocto strings', () => {
    expect(toYocto('42')).toBe(42n);
    expect(() => toYocto('4.2')).toThrow();
  });

  it('converts U64 nanoseconds to dates', () => {
    expect(nsToDate('1793391009201505000').toISOString()).toBe('2026-10-30T20:10:09.201Z');
  });
});
