import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { webhookEvents, type NewWebhookEvent } from '../db/schema.js';

/**
 * `new`: first delivery. `unprocessed`: seen before but handling failed, so handle it again.
 * `processed`: a true duplicate from PayPal; skip it.
 */
export type RecordedState = 'new' | 'unprocessed' | 'processed';

export interface WebhookEventStore {
  record(event: NewWebhookEvent): Promise<RecordedState>;
  markProcessed(eventId: string): Promise<void>;
}

export function drizzleWebhookEventStore(db: Db): WebhookEventStore {
  return {
    async record(event) {
      const inserted = await db
        .insert(webhookEvents)
        .values(event)
        .onConflictDoNothing({ target: webhookEvents.eventId })
        .returning({ eventId: webhookEvents.eventId });
      if (inserted.length > 0) return 'new';
      const [existing] = await db
        .select({ processedAt: webhookEvents.processedAt })
        .from(webhookEvents)
        .where(eq(webhookEvents.eventId, event.eventId))
        .limit(1);
      return existing?.processedAt ? 'processed' : 'unprocessed';
    },

    async markProcessed(eventId) {
      await db
        .update(webhookEvents)
        .set({ processedAt: new Date() })
        .where(eq(webhookEvents.eventId, eventId));
    },
  };
}
