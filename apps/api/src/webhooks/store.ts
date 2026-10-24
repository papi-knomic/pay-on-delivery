import type { Db } from '../db/client.js';
import { webhookEvents, type NewWebhookEvent } from '../db/schema.js';

export interface WebhookEventStore {
  /** Returns false if the event ID was already stored (duplicate delivery from PayPal). */
  insertIfNew(event: NewWebhookEvent): Promise<boolean>;
}

export function drizzleWebhookEventStore(db: Db): WebhookEventStore {
  return {
    async insertIfNew(event) {
      const inserted = await db
        .insert(webhookEvents)
        .values(event)
        .onConflictDoNothing({ target: webhookEvents.eventId })
        .returning({ eventId: webhookEvents.eventId });
      return inserted.length > 0;
    },
  };
}
