import type { DeliveryStatus } from '@pod/shared';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { deliveries, payments, payouts, riders, shipments, type Delivery } from '../db/schema.js';
import { StaleTransitionError, transitionDelivery } from '../deliveries/transition.js';
import type { Logger } from '../logger.js';
import { PayPalError, paypalRequestId, type PayPalClient } from '../paypal/index.js';

const CAPTURED: readonly DeliveryStatus[] = ['CAPTURED', 'PARTIALLY_CAPTURED'];

/** Payout item statuses after which polling stops. UNCLAIMED and ONHOLD can still change. */
const FINAL_ITEM_STATUSES = new Set([
  'SUCCESS',
  'FAILED',
  'RETURNED',
  'REFUNDED',
  'REVERSED',
  'BLOCKED',
  'CANCELED',
]);

export const MAX_PAYOUT_POLLS = 30;

export interface PayoutItemUpdate {
  payoutItemId: string;
  batchId?: string;
  transactionId?: string;
  status: string;
}

export interface Settlement {
  /** settle-delivery job: push tracking, then pay the rider. Runs after a capture commits. */
  settle(deliveryId: string): Promise<void>;
  /** poll-payout job: the fallback for missed payout webhooks. */
  pollPayout(deliveryId: string, attempt: number): Promise<void>;
  /** From a PAYMENT.PAYOUTS-ITEM.* webhook or a poll. SUCCESS settles the delivery. */
  recordPayoutItem(update: PayoutItemUpdate): Promise<void>;
  recordPayoutBatch(batchId: string, status: string): Promise<void>;
}

const isClientError = (err: unknown): err is PayPalError =>
  err instanceof PayPalError && err.status >= 400 && err.status < 500;

export function createSettlement(deps: {
  db: Db;
  logger: Logger;
  paypal: Pick<PayPalClient, 'addTracking' | 'createPayout' | 'getPayoutBatch'>;
  schedulePoll: (deliveryId: string, attempt: number) => Promise<unknown>;
}): Settlement {
  const { db, paypal } = deps;
  const baseLog = deps.logger.child({ component: 'settlement' });

  async function load(deliveryId: string): Promise<Delivery | undefined> {
    const [row] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId)).limit(1);
    return row;
  }

  /** PayPal requires the capture ID, which is why tracking waits until now. */
  async function pushTracking(delivery: Delivery, log: Logger): Promise<void> {
    const [capture] = await db
      .select({ paypalId: payments.paypalId })
      .from(payments)
      .where(and(eq(payments.deliveryId, delivery.id), eq(payments.kind, 'capture')))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    if (!capture || !delivery.paypalOrderId) return;

    const pending = await db
      .select()
      .from(shipments)
      .where(and(eq(shipments.deliveryId, delivery.id), isNull(shipments.pushedToPaypalAt)));
    for (const shipment of pending) {
      try {
        await paypal.addTracking({
          orderId: delivery.paypalOrderId,
          deliveryId: delivery.id,
          captureId: capture.paypalId,
          trackingNumber: shipment.trackingNumber,
          carrier: shipment.carrier,
          carrierNameOther: shipment.carrierNameOther ?? undefined,
        });
      } catch (err) {
        if (!isClientError(err)) throw err;
        // Tracking is nice to have; it must not hold up the rider's money.
        log.warn({ err, shipmentId: shipment.id }, 'PayPal rejected tracking; continuing');
        continue;
      }
      await db
        .update(shipments)
        .set({ pushedToPaypalAt: new Date(), paypalCaptureId: capture.paypalId })
        .where(eq(shipments.id, shipment.id));
      log.info({ shipmentId: shipment.id, captureId: capture.paypalId }, 'tracking pushed');
    }
  }

  async function payRider(delivery: Delivery, log: Logger): Promise<void> {
    if (!delivery.riderId || delivery.riderFeeCents <= 0) {
      log.error({ riderId: delivery.riderId }, 'captured delivery has no rider or fee; no payout');
      return;
    }
    const [rider] = await db.select().from(riders).where(eq(riders.id, delivery.riderId)).limit(1);
    if (!rider) throw new Error(`Rider ${delivery.riderId} not found`);

    const senderBatchId = paypalRequestId(delivery.id, 'payout');
    let created;
    try {
      // Same PayPal-Request-Id and sender_batch_id on retry, so this never pays twice.
      created = await paypal.createPayout({
        deliveryId: delivery.id,
        receiverEmail: rider.paypalEmail,
        amount: { cents: delivery.riderFeeCents },
      });
    } catch (err) {
      if (!isClientError(err)) throw err;
      log.error({ err }, 'PayPal refused the rider payout; delivery stays captured for ops');
      return;
    }

    await db.transaction(async (tx) => {
      await tx
        .insert(payouts)
        .values({
          id: newId('po'),
          deliveryId: delivery.id,
          riderId: rider.id,
          senderBatchId,
          paypalBatchId: created.batch_header.payout_batch_id,
          amountCents: delivery.riderFeeCents,
          batchStatus: created.batch_header.batch_status,
        })
        .onConflictDoNothing({ target: payouts.senderBatchId });
      await transitionDelivery(tx, log, delivery.id, delivery.status, 'PAYOUT_PENDING');
    });
    log.info(
      { batchId: created.batch_header.payout_batch_id, cents: delivery.riderFeeCents },
      'rider payout created',
    );
    await deps.schedulePoll(delivery.id, 1);
  }

  /** PAYOUT_PENDING → RIDER_PAID → SETTLED. The merchant already holds the capture minus the payout. */
  async function settleDelivery(deliveryId: string, log: Logger): Promise<void> {
    const delivery = await load(deliveryId);
    if (!delivery) return;
    try {
      let status = delivery.status;
      if (status === 'PAYOUT_PENDING') {
        status = (await transitionDelivery(db, log, deliveryId, status, 'RIDER_PAID')).status;
      }
      if (status === 'RIDER_PAID') {
        await transitionDelivery(db, log, deliveryId, status, 'SETTLED');
      }
    } catch (err) {
      // The webhook and the poll can race; whichever loses finds the work done.
      if (!(err instanceof StaleTransitionError)) throw err;
    }
  }

  const settlement: Settlement = {
    async settle(deliveryId) {
      const log = baseLog.child({ deliveryId });
      const delivery = await load(deliveryId);
      if (!delivery || !CAPTURED.includes(delivery.status)) {
        log.info({ status: delivery?.status }, 'nothing to settle');
        return;
      }
      await pushTracking(delivery, log);
      await payRider(delivery, log);
    },

    async pollPayout(deliveryId, attempt) {
      const log = baseLog.child({ deliveryId, attempt });
      const delivery = await load(deliveryId);
      if (!delivery || (delivery.status !== 'PAYOUT_PENDING' && delivery.status !== 'RIDER_PAID')) {
        return; // a webhook already settled it
      }
      const [payout] = await db
        .select()
        .from(payouts)
        .where(eq(payouts.deliveryId, deliveryId))
        .limit(1);
      if (!payout?.paypalBatchId) return;

      const batch = await paypal.getPayoutBatch(payout.paypalBatchId, deliveryId);
      await settlement.recordPayoutBatch(payout.paypalBatchId, batch.batch_header.batch_status);
      const item = batch.items[0];
      const status = item?.transaction_status ?? 'PENDING';
      if (item) {
        await settlement.recordPayoutItem({
          payoutItemId: item.payout_item_id,
          batchId: payout.paypalBatchId,
          transactionId: item.transaction_id,
          status,
        });
      }
      if (FINAL_ITEM_STATUSES.has(status)) return;
      if (attempt >= MAX_PAYOUT_POLLS) {
        log.warn(
          { status },
          'payout still not final; giving up polling (webhook may still arrive)',
        );
        return;
      }
      await deps.schedulePoll(deliveryId, attempt + 1);
    },

    async recordPayoutItem(update) {
      const [payout] = await db
        .select()
        .from(payouts)
        .where(
          or(
            eq(payouts.paypalItemId, update.payoutItemId),
            update.batchId ? eq(payouts.paypalBatchId, update.batchId) : undefined,
          ),
        )
        .limit(1);
      if (!payout) {
        baseLog.warn({ ...update }, 'payout item for an unknown payout');
        return;
      }
      const log = baseLog.child({ deliveryId: payout.deliveryId });
      await db
        .update(payouts)
        .set({ paypalItemId: update.payoutItemId, itemStatus: update.status })
        .where(eq(payouts.id, payout.id));
      if (payout.itemStatus !== update.status) {
        log.info({ itemId: update.payoutItemId, status: update.status }, 'payout item status');
      }
      if (update.status === 'SUCCESS') {
        await settleDelivery(payout.deliveryId, log);
      } else if (FINAL_ITEM_STATUSES.has(update.status)) {
        log.error({ status: update.status }, 'rider payout did not succeed; needs ops attention');
      }
    },

    async recordPayoutBatch(batchId, status) {
      await db
        .update(payouts)
        .set({ batchStatus: status })
        .where(eq(payouts.paypalBatchId, batchId));
    },
  };
  return settlement;
}
