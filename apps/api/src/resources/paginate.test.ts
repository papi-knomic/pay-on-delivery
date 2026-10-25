import { describe, expect, it, vi } from 'vitest';
import type { Delivery } from '../db/schema.js';
import { DeliveryResource } from './DeliveryResource.js';
import { pageQuerySchema, paginate } from './paginate.js';

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  const t = new Date('2026-10-06T10:00:00Z');
  return {
    id: 'dlv_1',
    merchantId: 'mer_1',
    buyerId: 'buy_1',
    riderId: null,
    status: 'AUTHORIZED',
    amountCents: 1250,
    riderFeeCents: 150,
    capturedAmountCents: null,
    currency: 'USD',
    deliveryAddress: '12 Admiralty Way, Lekki',
    items: null,
    deliveryLat: null,
    deliveryLng: null,
    otpHash: 'secret-hash',
    paypalOrderId: 'ORDER-1',
    currentAuthorizationId: 'AUTH-1',
    authorizedAt: t,
    honorPeriodFlaggedAt: null,
    createdAt: t,
    updatedAt: t,
    ...overrides,
  };
}

describe('pageQuerySchema', () => {
  it('coerces query-string values to numbers with defaults', () => {
    expect(pageQuerySchema.parse({})).toEqual({ page: 1, perPage: 15 });
    expect(pageQuerySchema.parse({ page: '3', perPage: '20' })).toEqual({ page: 3, perPage: 20 });
  });

  it('rejects out-of-range values', () => {
    expect(pageQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ perPage: '1000' }).success).toBe(false);
  });
});

describe('paginate', () => {
  it('runs rows + count, coerces the bigint-string total, and returns Reshaper meta', async () => {
    const rows = vi.fn(async (_limit: number, _offset: number) => [delivery()]);
    const result = await paginate(
      DeliveryResource,
      { page: 2, perPage: 10 },
      { rows, count: async () => '21' },
    );

    expect(rows).toHaveBeenCalledWith(10, 10);
    expect(result.meta).toEqual({ current_page: 2, per_page: 10, total: 21, last_page: 3 });
    expect(typeof result.meta.total).toBe('number');
    expect(result.data).toHaveLength(1);
  });

  it('passes transform options (isOps) through to the resource', async () => {
    const opts = { rows: async () => [delivery()], count: async () => 1 };
    const pub = await paginate(DeliveryResource, { page: 1, perPage: 15 }, opts, { isOps: false });
    const ops = await paginate(DeliveryResource, { page: 1, perPage: 15 }, opts, { isOps: true });
    expect(pub.data[0]).not.toHaveProperty('currentAuthorizationId');
    expect(ops.data[0]).toMatchObject({
      currentAuthorizationId: 'AUTH-1',
      paypalOrderId: 'ORDER-1',
    });
  });

  it('reports last_page 1 for an empty result', async () => {
    const result = await paginate(
      DeliveryResource,
      { page: 1, perPage: 15 },
      { rows: async () => [], count: async () => 0 },
    );
    expect(result.meta).toEqual({ current_page: 1, per_page: 15, total: 0, last_page: 1 });
  });
});

describe('DeliveryResource', () => {
  it('formats money as decimal strings with currency and hides internal fields', () => {
    const dto = DeliveryResource.transform(delivery({ capturedAmountCents: 600 }));
    expect(dto).toMatchObject({
      amount: '12.50',
      riderFee: '1.50',
      capturedAmount: '6.00',
      currency: 'USD',
    });
    expect(dto).not.toHaveProperty('otpHash');
    expect(dto).not.toHaveProperty('amountCents');
    expect(dto).not.toHaveProperty('paypalOrderId');
  });

  it('omits capturedAmount until something is captured', () => {
    expect(DeliveryResource.transform(delivery())).not.toHaveProperty('capturedAmount');
  });

  it('wraps single items in { data }', () => {
    const wrapped = DeliveryResource.wrap(DeliveryResource.transform(delivery()));
    expect(wrapped.data.id).toBe('dlv_1');
  });
});
