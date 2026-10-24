/**
 * Sandbox smoke test: AUTHORIZE order → buyer approval → authorize → (reauthorize probe) → void.
 * Usage: pnpm smoke:void
 */
import { createAndApproveOrder, createSmoke } from './lib.js';

const smoke = createSmoke('void');
const { paypal, deliveryId } = smoke;

const { orderId, authorizationId } = await createAndApproveOrder(smoke, 1000);

// PayPal documents reauthorization as allowed only after the 3-day honor period. This probe
// records what the sandbox actually does inside the honor period.
const reauth = await smoke.probe(
  'reauthorize inside honor period (expected to be rejected)',
  () => paypal.reauthorize({ authorizationId, deliveryId, attempt: 1 }),
  (a) => `unexpectedly accepted: new auth ${a.id} → ${a.status}`,
);
const toVoid = reauth?.id ?? authorizationId;

const voided = await smoke.step(
  'void authorization',
  () => paypal.voidAuthorization({ authorizationId: toVoid, deliveryId }),
  (a) => `auth ${a.id} → ${a.status}`,
);

await smoke.step(
  'authorization status is VOIDED',
  async () => {
    const a = await paypal.getAuthorization(toVoid, deliveryId);
    if (a.status !== 'VOIDED') throw new Error(`status is ${a.status}`);
    return a;
  },
  (a) => `auth ${a.id} → ${a.status}`,
);

await smoke.probe(
  'void again is idempotent (same PayPal-Request-Id)',
  () => paypal.voidAuthorization({ authorizationId: toVoid, deliveryId }),
  (a) => `auth ${a.id} → ${a.status}`,
);

smoke.print('order id', orderId);
smoke.print('authorization id', authorizationId);
if (reauth) smoke.print('reauthorized id', reauth.id);
smoke.print('voided status', voided.status);
smoke.finish();
