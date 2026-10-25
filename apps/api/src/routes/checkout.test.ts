import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import type { CheckoutService, StartCheckoutInput } from '../checkout/service.js';
import type { Db } from '../db/client.js';
import type { Delivery } from '../db/schema.js';
import type { EvidenceService } from '../evidence/service.js';

const t = new Date('2026-10-25T10:00:00Z');
const delivery: Delivery = {
  id: 'dlv_1',
  merchantId: 'mer_1',
  buyerId: 'buy_1',
  riderId: null,
  status: 'CREATED',
  amountCents: 2500,
  riderFeeCents: 300,
  capturedAmountCents: null,
  currency: 'USD',
  deliveryAddress: '14 Admiralty Way, Lekki',
  items: [{ name: 'Blender', quantity: 1, unitCents: 2200 }],
  deliveryLat: 6.4474,
  deliveryLng: 3.4723,
  otpHash: 'hash',
  paypalOrderId: 'ORDER-1',
  currentAuthorizationId: null,
  authorizedAt: null,
  honorPeriodFlaggedAt: null,
  createdAt: t,
  updatedAt: t,
};

const body = {
  merchantId: 'mer_1',
  buyer: { name: 'Ada', email: 'ada@example.com' },
  items: [{ name: 'Blender', quantity: 1, unitPrice: '22.00' }],
  deliveryFee: '3.00',
  deliveryAddress: '14 Admiralty Way, Lekki',
  deliveryLat: 6.4474,
  deliveryLng: 3.4723,
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(overrides: Partial<CheckoutService> = {}) {
  const start = vi.fn(async (_input: StartCheckoutInput) => ({
    ok: true as const,
    delivery,
    approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1',
    otp: '048213',
  }));
  const ship = vi.fn(async (_id: string, _input: { riderId: string }) => ({
    ok: true as const,
    delivery: { ...delivery, status: 'IN_TRANSIT' as const },
  }));
  const checkout: CheckoutService = {
    start,
    authorize: async () => ({
      ok: true as const,
      delivery: { ...delivery, status: 'AUTHORIZED' as const },
    }),
    authorizeByOrderId: async () => ({ ok: false, reason: 'not_found' }),
    ship,
    ...overrides,
  };
  app = await buildApp({
    logger: pino({ level: 'silent' }),
    db: {} as Db,
    checkout,
    evidence: {} as EvidenceService,
    paypal: { verifyWebhookSignature: async () => true },
    webhookStore: { record: async () => 'new', markProcessed: async () => {} },
    webhookId: 'WHID',
    healthChecks: { db: async () => {}, redis: async () => {} },
  });
  return { start, ship };
}

const post = (url: string, payload: unknown) =>
  app!.inject({ method: 'POST', url, payload: payload as object });

describe('POST /api/checkout', () => {
  it('converts prices to cents and returns the approval link and OTP once', async () => {
    const { start } = await setup();
    const res = await post('/api/checkout', body);

    expect(res.statusCode).toBe(201);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ name: 'Blender', quantity: 1, unitCents: 2200 }],
        deliveryFeeCents: 300,
      }),
    );
    const { data } = res.json<{ data: Record<string, unknown> }>();
    expect(data).toMatchObject({
      approveUrl: expect.stringContaining('ORDER-1') as string,
      otp: '048213',
      delivery: { id: 'dlv_1', amount: '25.00', riderFee: '3.00', status: 'CREATED' },
    });
    expect(JSON.stringify(data)).not.toContain('hash');
  });

  it.each([
    ['float-ish prices', { items: [{ name: 'x', quantity: 1, unitPrice: '1.005' }] }],
    ['numbers instead of strings', { deliveryFee: 3 }],
    ['no items', { items: [] }],
    ['free items', { items: [{ name: 'x', quantity: 1, unitPrice: '0.00' }] }],
    ['a total over the demo limit', { items: [{ name: 'x', quantity: 2, unitPrice: '600.00' }] }],
    ['lat without lng', { deliveryLng: undefined }],
  ])('rejects %s', async (_label, patch) => {
    const { start } = await setup();
    const res = await post('/api/checkout', { ...body, ...patch });
    expect(res.statusCode).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it('404s for an unknown merchant', async () => {
    await setup({ start: async () => ({ ok: false, reason: 'merchant_not_found' }) });
    expect((await post('/api/checkout', body)).statusCode).toBe(404);
  });
});

describe('POST /api/checkout/:id/authorize', () => {
  it('returns the authorized delivery', async () => {
    await setup();
    const res = await post('/api/checkout/dlv_1/authorize', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ data: { status: 'AUTHORIZED' } });
  });

  it('409s while the buyer has not approved', async () => {
    await setup({
      authorize: async () => ({
        ok: false,
        reason: 'not_approved',
        orderStatus: 'PAYER_ACTION_REQUIRED',
      }),
    });
    const res = await post('/api/checkout/dlv_1/authorize', {});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ data: { orderStatus: 'PAYER_ACTION_REQUIRED' } });
  });
});

describe('POST /api/deliveries/:id/ship', () => {
  it('assigns the rider and puts the delivery in transit', async () => {
    const { ship } = await setup();
    const res = await post('/api/deliveries/dlv_1/ship', { riderId: 'rdr_1' });
    expect(res.statusCode).toBe(200);
    expect(ship).toHaveBeenCalledWith('dlv_1', { riderId: 'rdr_1' });
    expect(res.json()).toMatchObject({ data: { status: 'IN_TRANSIT' } });
  });

  it('requires a rider and maps a wrong status to 409', async () => {
    await setup({ ship: async () => ({ ok: false, reason: 'wrong_status', status: 'CREATED' }) });
    expect((await post('/api/deliveries/dlv_1/ship', {})).statusCode).toBe(400);
    expect((await post('/api/deliveries/dlv_1/ship', { riderId: 'rdr_1' })).statusCode).toBe(409);
  });
});
