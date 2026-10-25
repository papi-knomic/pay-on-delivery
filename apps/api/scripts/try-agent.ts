/**
 * Run the delivery agent on a local photo, without the database or PayPal.
 *   pnpm agent:try path/to/photo.jpg [--note "buyer refused the blender"] [--gps-fail] [--reused]
 * Lookups return canned data, so this exercises the model, the tools and the policy layer only.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { CheckResult } from '@pod/shared';
import { runDeliveryAgent, type AgentContext } from '../src/agent/delivery-agent.js';
import { createLanguageModel } from '../src/agent/model.js';
import { applyPolicy } from '../src/agent/policy.js';
import { loadAiConfig } from '../src/env.js';
import { processPhoto } from '../src/evidence/photo.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    note: { type: 'string' },
    'gps-fail': { type: 'boolean', default: false },
    reused: { type: 'boolean', default: false },
  },
});
const photoPath = positionals[0];
if (!photoPath) {
  console.error('usage: pnpm agent:try <photo.jpg> [--note "..."] [--gps-fail] [--reused]');
  process.exit(2);
}
const ai = loadAiConfig();
if (!ai) {
  console.error('Set AI_PROVIDER, AI_MODEL and AI_API_KEY in .env');
  process.exit(2);
}

const photo = await processPhoto(await readFile(photoPath), { utcOffsetMinutes: 60 });
const checks: CheckResult[] = [
  values['gps-fail']
    ? {
        name: 'gps_distance',
        status: 'fail',
        detail: '2140 m from the delivery address; limit 150 m',
        value: 2140,
      }
    : {
        name: 'gps_distance',
        status: 'pass',
        detail: '38 m from the delivery address (±10 m); limit 150 m',
        value: 38,
      },
  { name: 'otp', status: 'pass', detail: 'Buyer OTP matches' },
  values.reused
    ? {
        name: 'photo_reuse',
        status: 'fail',
        detail: 'Photo matches one already used for delivery dlv_9Xq2',
        value: 2,
      }
    : {
        name: 'photo_reuse',
        status: 'pass',
        detail: 'Photo does not match any earlier upload',
        value: 31,
      },
  { name: 'photo_freshness', status: 'skipped', detail: 'Photo has no capture timestamp (EXIF)' },
];
const context: AgentContext = {
  delivery: {
    id: 'dlv_try',
    amountCents: 2500,
    riderFeeCents: 300,
    deliveryAddress: '14 Admiralty Way, Lekki Phase 1, Lagos',
    items: [
      { name: 'Blender', quantity: 1, unitCents: 1800 },
      { name: 'Plantain chips', quantity: 2, unitCents: 350 },
    ],
  },
  evidence: {
    attempt: 1,
    photo: photo.jpeg,
    uploadedAt: new Date(),
    photoTakenAt: photo.takenAt,
    riderNote: values.note ?? null,
    checks,
  },
};

const started = Date.now();
const run = await runDeliveryAgent({
  model: createLanguageModel(ai),
  context,
  lookups: {
    previousAttempts: async () => [],
    riderHistory: async () => ({
      deliveries: 41,
      settled: 39,
      escalated: 2,
      uploadsWithFailedChecks: 1,
    }),
    paypalAuthorization: async () => ({
      status: 'CREATED',
      amount: '25.00 USD',
      expires: '2026-11-22T00:00:00Z',
    }),
  },
});
const policy = applyPolicy({
  decision: run.decision,
  delivery: { status: 'VERIFYING', amountCents: 2500, riderFeeCents: 300 },
  checks,
  evidenceRequests: 0,
});

console.log(`\n${ai.provider}/${ai.model} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log('tools used:', run.toolCalls.map((c) => c.tool).join(', ') || '(none)');
console.log('decision:', JSON.stringify(run.decision, null, 2));
console.log('policy:', JSON.stringify(policy, null, 2));
