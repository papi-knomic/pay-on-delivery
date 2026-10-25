import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { createDb } from './db/client.js';
import { createLanguageModel } from './agent/model.js';
import { createVerifier } from './agent/verify.js';
import { aiConfigFrom, loadServerEnv } from './env.js';
import { createEvidenceService } from './evidence/service.js';
import { enqueueVerification, startJobs } from './jobs/worker.js';
import { createLogger } from './logger.js';
import { createPayPalClient } from './paypal/index.js';
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
  const verifyDelivery = createVerifier({
    db,
    logger,
    uploadDir: env.UPLOAD_DIR,
    paypal,
    model: ai ? createLanguageModel(ai) : null,
    modelName: ai ? `${ai.provider}/${ai.model}` : undefined,
  });
  const jobs = startJobs(env.REDIS_URL, logger, {
    'verify-delivery': (job) => verifyDelivery(job.data.deliveryId),
  });

  const app = await buildApp({
    logger,
    db,
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
