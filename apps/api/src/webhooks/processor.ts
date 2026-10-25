import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { CheckoutService } from '../checkout/service.js';
import type { Db } from '../db/client.js';
import { payments } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { PayPalWebhookEvent } from '../routes/webhooks.js';
import type { Settlement } from '../settlement/settlement.js';

const payoutItemResource = z.object({
  payout_item_id: z.string(),
  payout_batch_id: z.string().optional(),
  transaction_id: z.string().optional(),
  transaction_status: z.string().optional(),
});
const payoutBatchResource = z.object({
  batch_header: z.object({ payout_batch_id: z.string(), batch_status: z.string() }),
});
const captureResource = z.object({ id: z.string(), status: z.string() });

/** When an item event has no transaction_status, the event name says what happened. */
const ITEM_EVENT_STATUS: Record<string, string> = {
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': 'SUCCESS',
  'PAYMENT.PAYOUTS-ITEM.FAILED': 'FAILED',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED': 'BLOCKED',
  'PAYMENT.PAYOUTS-ITEM.CANCELED': 'CANCELED',
  'PAYMENT.PAYOUTS-ITEM.HELD': 'ONHOLD',
  'PAYMENT.PAYOUTS-ITEM.REFUNDED': 'REFUNDED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED': 'RETURNED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED': 'UNCLAIMED',
};

/**
 * Webhooks are the source of truth for final payment state. Every branch is idempotent because a
 * failed event is redelivered and handled again.
 */
export function createWebhookProcessor(deps: {
  db: Db;
  logger: Logger;
  settlement: Settlement;
  checkout: Pick<CheckoutService, 'authorizeByOrderId'>;
}): (event: PayPalWebhookEvent) => Promise<void> {
  const log = deps.logger.child({ component: 'webhooks' });

  return async (event) => {
    const type = event.event_type;

    // Backup for a buyer who approves and closes the tab before our return page authorizes.
    if (type === 'CHECKOUT.ORDER.APPROVED' && event.resource?.id) {
      const result = await deps.checkout.authorizeByOrderId(event.resource.id);
      log.info({ orderId: event.resource.id, ok: result.ok }, 'order approved');
      return;
    }

    if (type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
      const item = payoutItemResource.parse(event.resource);
      await deps.settlement.recordPayoutItem({
        payoutItemId: item.payout_item_id,
        batchId: item.payout_batch_id,
        transactionId: item.transaction_id,
        status: item.transaction_status ?? ITEM_EVENT_STATUS[type] ?? 'UNKNOWN',
      });
      return;
    }

    if (type.startsWith('PAYMENT.PAYOUTSBATCH.')) {
      const batch = payoutBatchResource.parse(event.resource);
      await deps.settlement.recordPayoutBatch(
        batch.batch_header.payout_batch_id,
        batch.batch_header.batch_status,
      );
      return;
    }

    if (
      type === 'PAYMENT.CAPTURE.COMPLETED' ||
      type === 'PAYMENT.CAPTURE.PENDING' ||
      type === 'PAYMENT.CAPTURE.DECLINED'
    ) {
      const capture = captureResource.parse(event.resource);
      const updated = await deps.db
        .update(payments)
        .set({ status: capture.status })
        .where(and(eq(payments.paypalId, capture.id), eq(payments.kind, 'capture')))
        .returning({ deliveryId: payments.deliveryId });
      const deliveryId = updated[0]?.deliveryId;
      if (type === 'PAYMENT.CAPTURE.DECLINED') {
        log.error({ deliveryId, captureId: capture.id }, 'capture declined after the fact');
      } else {
        log.info({ deliveryId, captureId: capture.id, status: capture.status }, 'capture status');
      }
      return;
    }

    // Order/authorization events and refunds are recorded in webhook_events; our own API calls
    // already applied their effects.
    log.debug({ eventType: type }, 'webhook stored, no handler');
  };
}
