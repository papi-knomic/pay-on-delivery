import { transition, type DeliveryStatus } from '@pod/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { deliveries, type Delivery } from '../db/schema.js';
import type { Logger } from '../logger.js';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The row's status changed underneath us (another request or job got there first). */
export class StaleTransitionError extends Error {
  constructor(
    readonly deliveryId: string,
    readonly from: DeliveryStatus,
    readonly to: DeliveryStatus,
  ) {
    super(`Delivery ${deliveryId} is no longer ${from}; cannot move it to ${to}`);
    this.name = 'StaleTransitionError';
  }
}

/**
 * The only way delivery.status changes. Checks the state machine, then updates only if the row
 * is still in `from`, so concurrent writers can't both win.
 */
export async function transitionDelivery(
  db: Db | Tx,
  log: Logger,
  deliveryId: string,
  from: DeliveryStatus,
  to: DeliveryStatus,
  extra: Partial<Omit<Delivery, 'id' | 'status'>> = {},
): Promise<Delivery> {
  transition(from, to);
  const [row] = await db
    .update(deliveries)
    .set({ ...extra, status: to })
    .where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, from)))
    .returning();
  if (!row) {
    throw new StaleTransitionError(deliveryId, from, to);
  }
  log.info({ deliveryId, from, to }, 'delivery transition');
  return row;
}
