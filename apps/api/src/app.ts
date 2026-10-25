import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { Resource } from '@kn0mic/reshaper';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { CheckoutService } from './checkout/service.js';
import type { Db } from './db/client.js';
import type { EvidenceService } from './evidence/service.js';
import type { PayPalClient } from './paypal/index.js';
import { checkoutRoutes } from './routes/checkout.js';
import { deliveryRoutes } from './routes/deliveries.js';
import { evidenceRoutes } from './routes/evidence.js';
import { healthRoutes, type HealthChecks } from './routes/health.js';
import { webhookRoutes, type PayPalWebhookEvent } from './routes/webhooks.js';
import type { WebhookEventStore } from './webhooks/store.js';

export interface AppDeps {
  logger: FastifyBaseLogger;
  db: Db;
  checkout: CheckoutService;
  evidence: EvidenceService;
  paypal: Pick<PayPalClient, 'verifyWebhookSignature'>;
  webhookStore: WebhookEventStore;
  webhookId: string | undefined;
  onWebhookEvent?: (event: PayPalWebhookEvent) => Promise<void>;
  healthChecks: HealthChecks;
  /** Built web app to serve (same origin). Skipped if missing, e.g. in dev where Vite serves it. */
  webDistDir?: string;
}

const NON_SPA_PREFIXES = ['/api', '/webhooks', '/health'];

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger,
    // Behind Cloudflare + Dokploy's Traefik: trust X-Forwarded-* for client IP and protocol.
    trustProxy: true,
  });

  await app.register(healthRoutes, { checks: deps.healthChecks });
  await app.register(deliveryRoutes, { prefix: '/api', db: deps.db });
  await app.register(evidenceRoutes, { prefix: '/api', evidence: deps.evidence });
  await app.register(checkoutRoutes, { prefix: '/api', checkout: deps.checkout });
  await app.register(webhookRoutes, {
    prefix: '/webhooks',
    paypal: deps.paypal,
    store: deps.webhookStore,
    webhookId: deps.webhookId,
    onEvent: deps.onWebhookEvent,
  });

  const indexHtml = deps.webDistDir ? join(deps.webDistDir, 'index.html') : undefined;
  const serveSpa = Boolean(deps.webDistDir && indexHtml && existsSync(indexHtml));
  if (serveSpa && deps.webDistDir) {
    await app.register(fastifyStatic, {
      root: deps.webDistDir,
      wildcard: true,
      index: 'index.html',
    });
    app.log.info({ dir: deps.webDistDir }, 'serving web app');
  }

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    const isApi = NON_SPA_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
    if (serveSpa && req.method === 'GET' && !isApi) {
      // SPA fallback: client-side routes (/rider/..., /ops/...) get index.html.
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send(Resource.wrap({ error: 'not found' }));
  });

  return app;
}
