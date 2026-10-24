import { Resource } from '@kn0mic/reshaper';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PayPalClient } from '../paypal/index.js';
import type { WebhookEventStore } from '../webhooks/store.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

const webhookEventSchema = z.object({
  id: z.string().min(1),
  event_type: z.string().min(1),
  resource_type: z.string().optional(),
  summary: z.string().optional(),
  resource: z.object({ id: z.string().optional() }).loose().optional(),
});

export interface WebhookRoutesOptions {
  paypal: Pick<PayPalClient, 'verifyWebhookSignature'>;
  store: WebhookEventStore;
  webhookId: string | undefined;
}

/** Registered under /webhooks. Keeps the raw body for signature verification (scoped to this plugin only). */
export const webhookRoutes: FastifyPluginAsync<WebhookRoutesOptions> = async (app, opts) => {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = body as string;
    req.rawBody = raw;
    try {
      done(null, JSON.parse(raw));
    } catch {
      const err = new Error('Invalid JSON body') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.post('/paypal', async (req, reply) => {
    if (!opts.webhookId) {
      req.log.error('PAYPAL_WEBHOOK_ID is not set; rejecting webhook');
      return reply.code(500).send(Resource.wrap({ error: 'webhook verification not configured' }));
    }
    const rawBody = req.rawBody;
    if (!rawBody) {
      return reply.code(400).send(Resource.wrap({ error: 'missing body' }));
    }

    let verified: boolean;
    try {
      verified = await opts.paypal.verifyWebhookSignature({
        webhookId: opts.webhookId,
        headers: req.headers,
        rawBody,
      });
    } catch (err) {
      // PayPal retries non-2xx deliveries, so a transient verification failure is safe to bounce.
      req.log.error({ err }, 'webhook verification call failed');
      return reply.code(502).send(Resource.wrap({ error: 'verification unavailable' }));
    }
    if (!verified) {
      req.log.warn('webhook signature verification failed');
      return reply.code(400).send(Resource.wrap({ error: 'invalid signature' }));
    }

    const parsed = webhookEventSchema.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn({ issues: parsed.error.issues }, 'verified webhook has unexpected shape');
      return reply.code(400).send(Resource.wrap({ error: 'invalid event' }));
    }
    const event = parsed.data;

    const isNew = await opts.store.insertIfNew({
      eventId: event.id,
      eventType: event.event_type,
      resourceType: event.resource_type ?? null,
      resourceId: event.resource?.id ?? null,
      summary: event.summary ?? null,
      payload: req.body,
    });

    req.log.info(
      {
        eventId: event.id,
        eventType: event.event_type,
        resourceId: event.resource?.id,
        duplicate: !isNew,
      },
      isNew ? 'paypal webhook received' : 'paypal webhook duplicate skipped',
    );
    return reply.code(200).send(Resource.wrap({ eventId: event.id, duplicate: !isNew }));
  });
};
