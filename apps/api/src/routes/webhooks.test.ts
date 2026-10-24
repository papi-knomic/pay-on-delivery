import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import type { Db } from '../db/client.js';
import type { NewWebhookEvent } from '../db/schema.js';
import type { WebhookEventStore } from '../webhooks/store.js';

function memoryStore(): WebhookEventStore & { events: NewWebhookEvent[] } {
  const events: NewWebhookEvent[] = [];
  return {
    events,
    async insertIfNew(event) {
      if (events.some((e) => e.eventId === event.eventId)) return false;
      events.push(event);
      return true;
    },
  };
}

const event = {
  id: 'WH-123',
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  resource_type: 'capture',
  summary: 'Payment completed',
  resource: { id: 'CAP-1' },
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(opts: { verified?: boolean | Error; webhookId?: string } = {}) {
  const store = memoryStore();
  const verifyWebhookSignature = vi.fn(async () => {
    if (opts.verified instanceof Error) throw opts.verified;
    return opts.verified ?? true;
  });
  app = await buildApp({
    logger: pino({ level: 'silent' }),
    db: {} as Db, // webhook route doesn't touch the DB directly
    paypal: { verifyWebhookSignature },
    webhookStore: store,
    webhookId: 'webhookId' in opts ? opts.webhookId : 'WHID',
    healthChecks: { db: async () => {}, redis: async () => {} },
  });
  const post = (payload: string) =>
    app!.inject({
      method: 'POST',
      url: '/webhooks/paypal',
      headers: { 'content-type': 'application/json', 'paypal-transmission-id': 'tx' },
      payload,
    });
  return { store, verifyWebhookSignature, post };
}

describe('POST /webhooks/paypal', () => {
  it('verifies against the raw body, stores the event, and acknowledges', async () => {
    const { store, verifyWebhookSignature, post } = await setup();
    const raw = JSON.stringify(event, null, 2); // formatting must survive to verification
    const res = await post(raw);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { eventId: 'WH-123', duplicate: false } });
    expect(verifyWebhookSignature).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: 'WHID', rawBody: raw }),
    );
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      eventId: 'WH-123',
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      resourceId: 'CAP-1',
    });
  });

  it('skips duplicates by event ID', async () => {
    const { store, post } = await setup();
    await post(JSON.stringify(event));
    const res = await post(JSON.stringify(event));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { eventId: 'WH-123', duplicate: true } });
    expect(store.events).toHaveLength(1);
  });

  it('rejects invalid signatures without storing', async () => {
    const { store, post } = await setup({ verified: false });
    const res = await post(JSON.stringify(event));
    expect(res.statusCode).toBe(400);
    expect(store.events).toHaveLength(0);
  });

  it('returns 502 when PayPal verification is unavailable so PayPal retries', async () => {
    const { store, post } = await setup({ verified: new Error('network') });
    const res = await post(JSON.stringify(event));
    expect(res.statusCode).toBe(502);
    expect(store.events).toHaveLength(0);
  });

  it('refuses to process when PAYPAL_WEBHOOK_ID is not configured', async () => {
    const { verifyWebhookSignature, post } = await setup({ webhookId: undefined });
    const res = await post(JSON.stringify(event));
    expect(res.statusCode).toBe(500);
    expect(verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON', async () => {
    const { post } = await setup();
    const res = await post('{not json');
    expect(res.statusCode).toBe(400);
  });

  it('unknown /api routes return a JSON 404', async () => {
    await setup();
    const res = await app!.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ data: { error: 'not found' } });
  });
});
