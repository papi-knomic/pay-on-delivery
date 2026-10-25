import { canTransition } from '@pod/shared';
import { and, count, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { deliveries, payments, type Delivery } from '../db/schema.js';
import { StaleTransitionError, transitionDelivery } from '../deliveries/transition.js';
import type { Logger } from '../logger.js';
import { PayPalError, paypalRequestId, type PayPalClient } from '../paypal/index.js';

/**
 * The day 3 / 4 / 29 jobs from CLAUDE.md, scheduled from the ORIGINAL authorizedAt. Each acts only
 * while the delivery is still uncaptured, which is exactly when EXPIRED is a legal transition.
 */
export interface AuthorizationLifecycle {
  flagHonorPeriod(deliveryId: string): Promise<void>;
  reauthorize(deliveryId: string): Promise<void>;
  expire(deliveryId: string): Promise<void>;
}

const uncaptured = (d: Delivery) => canTransition(d.status, 'EXPIRED');

export function createAuthorizationLifecycle(deps: {
  db: Db;
  logger: Logger;
  paypal: Pick<PayPalClient, 'reauthorize' | 'voidAuthorization'>;
}): AuthorizationLifecycle {
  const { db, paypal } = deps;
  const baseLog = deps.logger.child({ component: 'lifecycle' });

  async function load(deliveryId: string): Promise<Delivery | undefined> {
    const [row] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId)).limit(1);
    return row;
  }

  return {
    async flagHonorPeriod(deliveryId) {
      const delivery = await load(deliveryId);
      if (!delivery || !uncaptured(delivery)) return;
      await db
        .update(deliveries)
        .set({ honorPeriodFlaggedAt: new Date() })
        .where(and(eq(deliveries.id, deliveryId), isNull(deliveries.honorPeriodFlaggedAt)));
      baseLog.info({ deliveryId }, 'honor period ending; flagged for ops');
    },

    /** Swaps in a new authorization ID. No status change; the old row stays in payments. */
    async reauthorize(deliveryId) {
      const log = baseLog.child({ deliveryId });
      const delivery = await load(deliveryId);
      if (!delivery || !uncaptured(delivery) || !delivery.currentAuthorizationId) return;

      const [prior] = await db
        .select({ n: count() })
        .from(payments)
        .where(and(eq(payments.deliveryId, deliveryId), eq(payments.kind, 'authorization')));
      const attempt = Number(prior?.n ?? 1); // the original authorization is attempt 0
      let auth;
      try {
        auth = await paypal.reauthorize({
          authorizationId: delivery.currentAuthorizationId,
          deliveryId,
          attempt,
        });
      } catch (err) {
        if (err instanceof PayPalError && err.status >= 400 && err.status < 500) {
          // The original authorization stays usable until day 29; the expire job still runs.
          log.error({ err }, 'reauthorization refused; keeping the current authorization');
          return;
        }
        throw err;
      }

      await db.transaction(async (tx) => {
        await tx
          .insert(payments)
          .values({
            id: newId('pay'),
            deliveryId,
            kind: 'authorization',
            paypalId: auth.id,
            parentPaypalId: delivery.currentAuthorizationId,
            attempt,
            amountCents: delivery.amountCents,
            status: auth.status,
            requestId: paypalRequestId(deliveryId, 'reauthorize', attempt),
            expiresAt: auth.expiration_time ? new Date(auth.expiration_time) : null,
          })
          .onConflictDoNothing({ target: payments.paypalId });
        await tx
          .update(deliveries)
          .set({ currentAuthorizationId: auth.id })
          .where(eq(deliveries.id, deliveryId));
      });
      log.info({ from: delivery.currentAuthorizationId, to: auth.id, attempt }, 'reauthorized');
    },

    /** Void before PayPal lapses the authorization, so the buyer's funds are released cleanly. */
    async expire(deliveryId) {
      const log = baseLog.child({ deliveryId });
      const delivery = await load(deliveryId);
      if (!delivery || !uncaptured(delivery)) return;

      if (delivery.currentAuthorizationId) {
        try {
          await paypal.voidAuthorization({
            authorizationId: delivery.currentAuthorizationId,
            deliveryId,
          });
        } catch (err) {
          // Already voided or expired at PayPal: nothing left to release.
          if (!(err instanceof PayPalError && err.status >= 400 && err.status < 500)) throw err;
          log.warn({ err }, 'void at expiry refused; marking expired anyway');
        }
      }
      try {
        await transitionDelivery(db, log, deliveryId, delivery.status, 'EXPIRED');
      } catch (err) {
        if (!(err instanceof StaleTransitionError)) throw err;
        // It moved (for example, was captured) while we voided. Re-run against the new state.
        log.warn('delivery changed during expiry; re-checking');
        throw err;
      }
    },
  };
}
