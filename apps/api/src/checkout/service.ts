import { randomInt } from 'node:crypto';
import type { DeliveryStatus, OrderItem } from '@pod/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  buyers,
  deliveries,
  merchants,
  payments,
  riders,
  shipments,
  type Delivery,
} from '../db/schema.js';
import { StaleTransitionError, transitionDelivery } from '../deliveries/transition.js';
import type { Logger } from '../logger.js';
import {
  approvalUrl,
  firstAuthorization,
  paypalRequestId,
  type PayPalClient,
} from '../paypal/index.js';
import { hashOtp } from '../verification/checks.js';

export interface StartCheckoutInput {
  merchantId: string;
  buyer: { name: string; email?: string; phone?: string };
  items: OrderItem[];
  deliveryFeeCents: number;
  deliveryAddress: string;
  deliveryLat?: number;
  deliveryLng?: number;
}

export type StartCheckoutResult =
  | { ok: true; delivery: Delivery; approveUrl: string; otp: string }
  | { ok: false; reason: 'merchant_not_found' };

export type AuthorizeResult =
  | { ok: true; delivery: Delivery }
  | { ok: false; reason: 'not_found' | 'no_order' }
  | { ok: false; reason: 'not_approved'; orderStatus: string }
  | { ok: false; reason: 'wrong_status'; status: DeliveryStatus };

export type ShipResult =
  | { ok: true; delivery: Delivery }
  | { ok: false; reason: 'not_found' | 'rider_not_found' | 'conflict' }
  | { ok: false; reason: 'wrong_status'; status: DeliveryStatus };

export interface CheckoutService {
  start(input: StartCheckoutInput): Promise<StartCheckoutResult>;
  /** After the buyer approves on PayPal. Idempotent: the return page and the webhook both call it. */
  authorize(deliveryId: string): Promise<AuthorizeResult>;
  authorizeByOrderId(paypalOrderId: string): Promise<AuthorizeResult>;
  ship(
    deliveryId: string,
    input: { riderId: string; carrier?: string; trackingNumber?: string },
  ): Promise<ShipResult>;
}

/** PayPal's carrier enum has no Lagos dispatch riders, so ours report as OTHER. */
const OWN_CARRIER = { carrier: 'OTHER', carrierNameOther: 'Pay on Delivery rider' } as const;

export function createCheckoutService(deps: {
  db: Db;
  logger: Logger;
  paypal: Pick<PayPalClient, 'createOrder' | 'getOrder' | 'authorizeOrder'>;
  publicBaseUrl: string;
  /** Schedules the day 3 / 4 / 29 authorization jobs. */
  onAuthorized?: (delivery: Delivery) => Promise<void>;
}): CheckoutService {
  const { db, paypal } = deps;
  const log = deps.logger.child({ component: 'checkout' });
  const base = deps.publicBaseUrl.replace(/\/$/, '');

  async function load(deliveryId: string): Promise<Delivery | undefined> {
    const [row] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId)).limit(1);
    return row;
  }

  const service: CheckoutService = {
    async start(input) {
      const [merchant] = await db
        .select()
        .from(merchants)
        .where(eq(merchants.id, input.merchantId))
        .limit(1);
      if (!merchant) return { ok: false, reason: 'merchant_not_found' };

      const id = newId('dlv');
      // Shown to the buyer once; they read it to the rider at handover. Only the hash is stored.
      const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const itemsCents = input.items.reduce((sum, i) => sum + i.quantity * i.unitCents, 0);
      const amountCents = itemsCents + input.deliveryFeeCents;

      await db.transaction(async (tx) => {
        const buyerId = newId('buy');
        await tx.insert(buyers).values({ id: buyerId, ...input.buyer });
        await tx.insert(deliveries).values({
          id,
          merchantId: merchant.id,
          buyerId,
          amountCents,
          riderFeeCents: input.deliveryFeeCents,
          deliveryAddress: input.deliveryAddress,
          deliveryLat: input.deliveryLat ?? null,
          deliveryLng: input.deliveryLng ?? null,
          items: input.items,
          otpHash: hashOtp(id, otp),
        });
      });

      const order = await paypal.createOrder({
        deliveryId: id,
        amount: { cents: amountCents },
        description: `${merchant.name} order ${id}`,
        returnUrl: `${base}/checkout/return?delivery=${id}`,
        cancelUrl: `${base}/checkout/cancel?delivery=${id}`,
        brandName: merchant.name,
        items: input.items,
        shippingCents: input.deliveryFeeCents,
      });
      const approveUrl = approvalUrl(order);
      if (!approveUrl) throw new Error(`PayPal order ${order.id} has no approval link`);

      const [delivery] = await db
        .update(deliveries)
        .set({ paypalOrderId: order.id })
        .where(eq(deliveries.id, id))
        .returning();
      log.info({ deliveryId: id, orderId: order.id, amountCents }, 'checkout started');
      return { ok: true, delivery: delivery!, approveUrl, otp };
    },

    async authorize(deliveryId) {
      const delivery = await load(deliveryId);
      if (!delivery) return { ok: false, reason: 'not_found' };
      if (delivery.status !== 'CREATED') {
        // Already authorized (by the return page or the webhook): report success, not an error.
        return delivery.currentAuthorizationId
          ? { ok: true, delivery }
          : { ok: false, reason: 'wrong_status', status: delivery.status };
      }
      if (!delivery.paypalOrderId) return { ok: false, reason: 'no_order' };

      const order = await paypal.getOrder(delivery.paypalOrderId, deliveryId);
      // COMPLETED: authorized at PayPal, but our write didn't land. The same request ID replays it.
      if (order.status !== 'APPROVED' && order.status !== 'COMPLETED') {
        return { ok: false, reason: 'not_approved', orderStatus: order.status };
      }
      const authorized = await paypal.authorizeOrder({
        orderId: delivery.paypalOrderId,
        deliveryId,
      });
      const auth = firstAuthorization(authorized);
      if (!auth) throw new Error(`Authorize response for ${deliveryId} has no authorization`);

      const now = new Date();
      try {
        const updated = await db.transaction(async (tx) => {
          await tx
            .insert(payments)
            .values({
              id: newId('pay'),
              deliveryId,
              kind: 'authorization',
              paypalId: auth.id,
              amountCents: delivery.amountCents,
              status: auth.status,
              requestId: paypalRequestId(deliveryId, 'authorize'),
              expiresAt: auth.expiration_time ? new Date(auth.expiration_time) : null,
            })
            .onConflictDoNothing({ target: payments.paypalId });
          return transitionDelivery(tx, log, deliveryId, 'CREATED', 'AUTHORIZED', {
            currentAuthorizationId: auth.id,
            authorizedAt: now,
          });
        });
        await deps.onAuthorized?.(updated);
        return { ok: true, delivery: updated };
      } catch (err) {
        if (!(err instanceof StaleTransitionError)) throw err;
        const current = await load(deliveryId);
        return current?.currentAuthorizationId
          ? { ok: true, delivery: current }
          : { ok: false, reason: 'wrong_status', status: current?.status ?? 'CREATED' };
      }
    },

    async authorizeByOrderId(paypalOrderId) {
      const [row] = await db
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(eq(deliveries.paypalOrderId, paypalOrderId))
        .limit(1);
      return row ? service.authorize(row.id) : { ok: false, reason: 'not_found' };
    },

    async ship(deliveryId, input) {
      const delivery = await load(deliveryId);
      if (!delivery) return { ok: false, reason: 'not_found' };
      if (delivery.status !== 'AUTHORIZED') {
        return { ok: false, reason: 'wrong_status', status: delivery.status };
      }
      const [rider] = await db.select().from(riders).where(eq(riders.id, input.riderId)).limit(1);
      if (!rider) return { ok: false, reason: 'rider_not_found' };

      try {
        const updated = await db.transaction(async (tx) => {
          // Stored now, pushed to PayPal only after capture (PayPal needs the capture ID).
          await tx.insert(shipments).values({
            id: newId('shp'),
            deliveryId,
            ...(input.carrier ? { carrier: input.carrier } : OWN_CARRIER),
            trackingNumber: input.trackingNumber ?? deliveryId.toUpperCase(),
          });
          return transitionDelivery(tx, log, deliveryId, 'AUTHORIZED', 'IN_TRANSIT', {
            riderId: rider.id,
          });
        });
        return { ok: true, delivery: updated };
      } catch (err) {
        if (err instanceof StaleTransitionError) return { ok: false, reason: 'conflict' };
        throw err;
      }
    },
  };
  return service;
}
