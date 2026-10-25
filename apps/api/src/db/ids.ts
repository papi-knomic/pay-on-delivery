import { randomBytes } from 'node:crypto';

export type IdPrefix = 'dlv' | 'mer' | 'rdr' | 'buy' | 'shp' | 'dec' | 'pay' | 'po' | 'evd';

/** Short prefixed IDs (`dlv_k3j9...`) so idempotency keys and logs are readable. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}
