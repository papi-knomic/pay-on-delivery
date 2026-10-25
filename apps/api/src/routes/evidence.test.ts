import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import type { CheckoutService } from '../checkout/service.js';
import type { Db } from '../db/client.js';
import type { Evidence } from '../db/schema.js';
import type {
  EvidenceService,
  SubmitEvidenceInput,
  SubmitEvidenceResult,
} from '../evidence/service.js';

const row: Evidence = {
  id: 'evd_1',
  deliveryId: 'dlv_1',
  attempt: 1,
  photoPath: 'dlv_1/evd_1.jpg',
  photoHash: 'a5a5a5a5a5a5a5a5',
  photoTakenAt: new Date('2026-10-24T12:05:00Z'),
  lat: 6.4474,
  lng: 3.4723,
  gpsAccuracyM: 12,
  otpSubmitted: true,
  riderNote: null,
  checks: [{ name: 'gps_distance', status: 'pass', detail: '10 m', value: 10 }],
  createdAt: new Date('2026-10-24T12:06:00Z'),
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(result: SubmitEvidenceResult = { ok: true, evidence: row }) {
  const submit = vi.fn(async (_input: SubmitEvidenceInput) => result);
  const evidence: EvidenceService = { submit, photoPath: async () => null };
  app = await buildApp({
    logger: pino({ level: 'silent' }),
    db: {} as Db,
    evidence,
    checkout: {} as CheckoutService,
    paypal: { verifyWebhookSignature: async () => true },
    webhookStore: { record: async () => 'new', markProcessed: async () => {} },
    webhookId: 'WHID',
    healthChecks: { db: async () => {}, redis: async () => {} },
  });
  const upload = async (fields: Record<string, string>, withPhoto = true) => {
    const form = new FormData();
    if (withPhoto) form.append('photo', new Blob([Buffer.from('jpeg-bytes')]), 'door.jpg');
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const request = new Request('http://test.local', { method: 'POST', body: form });
    return app!.inject({
      method: 'POST',
      url: '/api/deliveries/dlv_1/evidence',
      headers: { 'content-type': request.headers.get('content-type')! },
      payload: Buffer.from(await request.arrayBuffer()),
    });
  };
  return { submit, upload };
}

describe('POST /api/deliveries/:id/evidence', () => {
  it('parses the form and returns a rider receipt without ops-only fields', async () => {
    const { submit, upload } = await setup();
    const res = await upload({
      lat: '6.4474',
      lng: '3.4723',
      accuracyM: '12',
      otp: ' 482913 ',
      utcOffsetMinutes: '60',
    });

    expect(res.statusCode).toBe(201);
    const input = submit.mock.calls[0]![0];
    expect(input).toMatchObject({
      deliveryId: 'dlv_1',
      gps: { lat: 6.4474, lng: 3.4723, accuracyM: 12 },
      otp: '482913',
      utcOffsetMinutes: 60,
    });
    expect(input.photo.toString()).toBe('jpeg-bytes');

    const { data } = res.json<{ data: Record<string, unknown> }>();
    expect(data).toMatchObject({ id: 'evd_1', attempt: 1, photoUrl: '/api/evidence/evd_1/photo' });
    expect(data).not.toHaveProperty('gps');
    expect(data).not.toHaveProperty('checks');
    expect(data).not.toHaveProperty('photoPath');
  });

  it('treats blank optional fields as missing', async () => {
    const { submit, upload } = await setup();
    const res = await upload({ lat: '', lng: '', otp: '' });
    expect(res.statusCode).toBe(201);
    expect(submit.mock.calls[0]![0]).toMatchObject({ gps: null, otp: undefined });
  });

  it('rejects a request without a photo', async () => {
    const { submit, upload } = await setup();
    const res = await upload({ lat: '6.4', lng: '3.4' }, false);
    expect(res.statusCode).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    ['lat without lng', { lat: '6.4' }],
    ['lat out of range', { lat: '95', lng: '3.4' }],
    ['non-numeric accuracy', { lat: '6.4', lng: '3.4', accuracyM: 'close' }],
  ])('rejects %s', async (_label, fields) => {
    const { submit, upload } = await setup();
    expect((await upload(fields)).statusCode).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, reason: 'not_found' } as const, 404],
    [{ ok: false, reason: 'invalid_photo' } as const, 400],
    [{ ok: false, reason: 'not_accepting', status: 'CAPTURED' } as const, 409],
    [{ ok: false, reason: 'conflict' } as const, 409],
  ])('maps %o to HTTP %i', async (result, status) => {
    const { upload } = await setup(result);
    expect((await upload({})).statusCode).toBe(status);
  });
});

describe('GET /api/evidence/:id/photo', () => {
  it('404s for unknown evidence', async () => {
    await setup();
    expect((await app!.inject({ url: '/api/evidence/evd_nope/photo' })).statusCode).toBe(404);
  });
});
