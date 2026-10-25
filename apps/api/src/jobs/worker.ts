import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Logger } from '../logger.js';

export const DELIVERY_LIFECYCLE_QUEUE = 'delivery-lifecycle';

/**
 * verify-delivery runs the agent on new evidence. The rest are the authorization lifecycle
 * (day 3 flag / day 4 reauthorize / day 29 expire) and the payout polling fallback; see CLAUDE.md.
 */
export type LifecycleJobName =
  'verify-delivery' | 'flag-honor-period' | 'reauthorize' | 'expire-authorization' | 'poll-payout';

export interface LifecycleJobData {
  deliveryId: string;
}

export type JobHandler = (job: Job<LifecycleJobData>) => Promise<void>;

export interface Jobs {
  queue: Queue<LifecycleJobData>;
  worker: Worker<LifecycleJobData>;
  close: () => Promise<void>;
}

/** One job per upload (BullMQ ignores a duplicate jobId). Retries cover transient PayPal errors. */
export function enqueueVerification(
  queue: Queue<LifecycleJobData>,
  input: { deliveryId: string; evidenceId: string },
): Promise<unknown> {
  return queue.add(
    'verify-delivery',
    { deliveryId: input.deliveryId },
    {
      jobId: `verify-${input.evidenceId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 1_000,
      removeOnFail: 1_000,
    },
  );
}

/** Runs in the API process (per CLAUDE.md). */
export function startJobs(
  redisUrl: string,
  logger: Logger,
  handlers: Partial<Record<LifecycleJobName, JobHandler>> = {},
): Jobs {
  const log = logger.child({ component: 'jobs' });
  // BullMQ workers need maxRetriesPerRequest: null on their blocking connection.
  const connection = { url: redisUrl, maxRetriesPerRequest: null };

  const queue = new Queue<LifecycleJobData>(DELIVERY_LIFECYCLE_QUEUE, { connection });
  const worker = new Worker<LifecycleJobData>(
    DELIVERY_LIFECYCLE_QUEUE,
    async (job) => {
      const handler = handlers[job.name as LifecycleJobName];
      if (!handler) {
        throw new UnrecoverableError(`No handler for job "${job.name}"`);
      }
      log.info({ jobId: job.id, name: job.name, deliveryId: job.data.deliveryId }, 'job start');
      await handler(job);
    },
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    log.error(
      { jobId: job?.id, name: job?.name, deliveryId: job?.data?.deliveryId, err },
      'job failed',
    );
  });
  worker.on('error', (err) => log.error({ err }, 'worker error'));

  return {
    queue,
    worker,
    async close() {
      // worker.close() waits for in-flight jobs to finish.
      await worker.close();
      await queue.close();
    },
  };
}
