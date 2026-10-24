import { describe, expect, it } from 'vitest';
import { centsToDecimal, decimalToCents } from './money.js';

describe('money', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [100, '1.00'],
    [1250, '12.50'],
    [123456789, '1234567.89'],
  ])('centsToDecimal(%i) = %s', (cents, decimal) => {
    expect(centsToDecimal(cents)).toBe(decimal);
    expect(decimalToCents(decimal)).toBe(cents);
  });

  it('accepts one or zero fraction digits', () => {
    expect(decimalToCents('12')).toBe(1200);
    expect(decimalToCents('12.5')).toBe(1250);
  });

  it.each([-1, 1.5, Number.NaN])('centsToDecimal rejects %s', (bad) => {
    expect(() => centsToDecimal(bad)).toThrow(RangeError);
  });

  it.each(['', '-1.00', '1.234', 'abc', '1,000.00'])('decimalToCents rejects "%s"', (bad) => {
    expect(() => decimalToCents(bad)).toThrow(RangeError);
  });
});
