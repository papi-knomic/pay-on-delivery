import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { createDb } from './db/client.js';
import { createLanguageModel } from './agent/model.js';
import { createVerifier } from './agent/verify.js';
import { aiConfigFrom, loadServerEnv } from './env.js';
import { createEvidenceService } from './evidence/service.js';
import { createCheckoutService } from './checkout/service.js';
import {
  enqueueSettlement,
  enqueueVerification,
  scheduleAuthorizationLifecycle,
  schedulePayoutPoll,
  startJobs,
} from './jobs/worker.js';
import { createAuthorizationLifecycle } from './lifecycle/authorization.js';
import { createLogger } from './logger.js';
import { createPayPalClient } from './paypal/index.js';
import { createSettlement } from './settlement/settlement.js';
import { createWebhookProcessor } from './webhooks/processor.js';
import { drizzleWebhookEventStore } from './webhooks/store.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const env = loadServerEnv();
  const logger = createLogger(env.LOG_LEVEL);

  if (!env.PAYPAL_WEBHOOK_ID) {
    logger.warn('PAYPAL_WEBHOOK_ID is not set: /webhooks/paypal will reject every event');
  }

  const { db, pool } = createDb(env.DATABASE_URL);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: false });
  redis.on('error', (err) => logger.error({ err }, 'redis error'));
  const paypal = createPayPalClient(env, logger);

  const ai = aiConfigFrom(env);
  if (!ai) {
    logger.warn('AI_PROVIDER / AI_MODEL / AI_API_KEY not set: every delivery will be escalated');
  }
  // The job handlers enqueue follow-up jobs; `jobs` is assigned before any handler can run.
  const settlement = createSettlement({
    db,
    logger,
    paypal,
    schedulePoll: (deliveryId, attempt) => schedulePayoutPoll(jobs.queue, deliveryId, attempt),
  });
  const verifyDelivery = createVerifier({
    db,
    logger,
    uploadDir: env.UPLOAD_DIR,
    paypal,
    model: ai ? createLanguageModel(ai) : null,
    modelName: ai ? `${ai.provider}/${ai.model}` : undefined,
    onCaptured: async (deliveryId) => {
      await enqueueSettlement(jobs.queue, deliveryId);
    },
  });
  const lifecycle = createAuthorizationLifecycle({ db, logger, paypal });
  const jobs = startJobs(env.REDIS_URL, logger, {
    'verify-delivery': (job) => verifyDelivery(job.data.deliveryId),
    'settle-delivery': (job) => settlement.settle(job.data.deliveryId),
    'poll-payout': (job) => settlement.pollPayout(job.data.deliveryId, job.data.attempt ?? 1),
    'flag-honor-period': (job) => lifecycle.flagHonorPeriod(job.data.deliveryId),
    reauthorize: (job) => lifecycle.reauthorize(job.data.deliveryId),
    'expire-authorization': (job) => lifecycle.expire(job.data.deliveryId),
  });
  const checkout = createCheckoutService({
    db,
    logger,
    paypal,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    onAuthorized: async (delivery) => {
      if (delivery.authorizedAt) {
        await scheduleAuthorizationLifecycle(jobs.queue, delivery.id, delivery.authorizedAt);
      }
    },
  });

  const app = await buildApp({
    logger,
    db,
    checkout,
    evidence: createEvidenceService({
      db,
      logger,
      uploadDir: env.UPLOAD_DIR,
      onSubmitted: async (ev) => {
        await enqueueVerification(jobs.queue, { deliveryId: ev.deliveryId, evidenceId: ev.id });
      },
    }),
    paypal,
    webhookStore: drizzleWebhookEventStore(db),
    webhookId: env.PAYPAL_WEBHOOK_ID,
    onWebhookEvent: createWebhookProcessor({ db, logger, settlement, checkout }),
    healthChecks: {
      db: async () => {
        await db.execute(sql`select 1`);
      },
      redis: async () => {
        await redis.ping();
      },
    },
    webDistDir: env.WEB_DIST_DIR ?? resolve(import.meta.dirname, '../public'),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      await app.close(); // stop accepting connections, drain in-flight requests
      await jobs.close(); // let running jobs finish
      await Promise.allSettled([pool.end(), redis.quit()]);
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.API_PORT, host: env.API_HOST });
}

main().catch((err: unknown) => {
  console.error('fatal: server failed to start', err);
  process.exit(1);
});
