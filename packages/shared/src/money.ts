/** PayPal does not support NGN; every amount sent to PayPal is USD. */
export const PAYPAL_CURRENCY = 'USD' as const;
export type PayPalCurrency = typeof PAYPAL_CURRENCY;

/** 1250 → "12.50". Amounts are always integer minor units; never floats. */
export function centsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError(`Amount must be a non-negative integer number of cents, got ${cents}`);
  }
  const whole = Math.trunc(cents / 100);
  const fraction = String(cents % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}

/** "12.50" → 1250. Parses the string directly so no float arithmetic is involved. */
export function decimalToCents(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) {
    throw new RangeError(`Not a valid decimal amount: "${value}"`);
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const cents = whole * 100 + fraction;
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`Amount out of range: "${value}"`);
  }
  return cents;
}
