/**
 * Sandbox smoke test: AUTHORIZE order → buyer approval → authorize → PARTIAL capture → push tracking.
 * Usage: pnpm smoke:authorize-capture
 */
import { orderSchema } from '../src/paypal/index.js';
import { createAndApproveOrder, createSmoke } from './lib.js';

const AUTHORIZED_CENTS = 1000; // $10.00
const CAPTURE_CENTS = 600; // $6.00 partial

const smoke = createSmoke('authorize-capture');
const { paypal, deliveryId } = smoke;

const { orderId, authorizationId } = await createAndApproveOrder(smoke, AUTHORIZED_CENTS);

await smoke.probe(
  'add tracking BEFORE capture (expected to fail)',
  () =>
    paypal.request({
      method: 'POST',
      path: `/v2/checkout/orders/${orderId}/track`,
      requestId: `${deliveryId}:track-precapture`,
      deliveryId,
      action: 'track-precapture-probe',
      schema: orderSchema,
      body: {
        tracking_number: `PRE-${Date.now()}`,
        carrier: 'OTHER',
        carrier_name_other: 'Pay on Delivery rider',
      },
    }),
  () => 'unexpectedly accepted: tracking may not need capture_id',
);

const capture = await smoke.step(
  'partial capture $6.00 of $10.00 (final_capture: true)',
  () =>
    paypal.captureAuthorization({ authorizationId, deliveryId, amount: { cents: CAPTURE_CENTS } }),
  (c) =>
    `capture ${c.id} → ${c.status}${c.status_details?.reason ? ` (${c.status_details.reason})` : ''}`,
);

await smoke.step(
  'capture is COMPLETED or PENDING',
  async () => {
    if (!['COMPLETED', 'PENDING'].includes(capture.status))
      throw new Error(`capture status ${capture.status}`);
    return capture.status;
  },
  (s) => s,
);

await smoke.step(
  'authorization reflects final partial capture',
  () => paypal.getAuthorization(authorizationId, deliveryId),
  (a) =>
    `auth ${a.id} → ${a.status}` +
    (a.status === 'PARTIALLY_CAPTURED'
      ? ' (remainder NOT released: revisit "no void after partial capture")'
      : ''),
);

await smoke.step(
  'push tracking AFTER capture (with capture_id)',
  () =>
    paypal.addTracking({
      orderId,
      deliveryId,
      captureId: capture.id,
      trackingNumber: `POD-${Date.now()}`,
      carrier: 'OTHER',
      carrierNameOther: 'Pay on Delivery rider',
    }),
  (o) => `order ${o.id} → ${o.status}`,
);

smoke.print('order id', orderId);
smoke.print('authorization id', authorizationId);
smoke.print('capture id', capture.id);
smoke.finish();
