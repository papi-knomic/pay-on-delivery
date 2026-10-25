import { authorizationSchedule } from '@pod/shared';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Logger } from '../logger.js';

export const DELIVERY_LIFECYCLE_QUEUE = 'delivery-lifecycle';

/**
 * verify-delivery runs the agent on new evidence; settle-delivery pushes tracking and pays the
 * rider after a capture; poll-payout is the fallback for missed payout webhooks. The rest are the
 * authorization lifecycle (day 3 flag / day 4 reauthorize / day 29 expire); see CLAUDE.md.
 */
export type LifecycleJobName =
  | 'verify-delivery'
  | 'settle-delivery'
  | 'poll-payout'
  | 'flag-honor-period'
  | 'reauthorize'
  | 'expire-authorization';

export interface LifecycleJobData {
  deliveryId: string;
  /** poll-payout only: which poll this is, so polling can stop. */
  attempt?: number;
}

const RETRY = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: 1_000,
  removeOnFail: 1_000,
} as const;

const PAYOUT_POLL_DELAY_MS = 60_000;

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
    { ...RETRY, jobId: `verify-${input.evidenceId}` },
  );
}

/** One settlement per delivery: a capture happens at most once. */
export function enqueueSettlement(
  queue: Queue<LifecycleJobData>,
  deliveryId: string,
): Promise<unknown> {
  return queue.add('settle-delivery', { deliveryId }, { ...RETRY, jobId: `settle-${deliveryId}` });
}

/** Day 3 / 4 / 29 jobs, timed from the ORIGINAL authorization (see authorizationSchedule). */
export async function scheduleAuthorizationLifecycle(
  queue: Queue<LifecycleJobData>,
  deliveryId: string,
  authorizedAt: Date,
): Promise<void> {
  const schedule = authorizationSchedule(authorizedAt);
  const delay = (at: Date) => Math.max(0, at.getTime() - Date.now());
  await Promise.all([
    queue.add(
      'flag-honor-period',
      { deliveryId },
      { ...RETRY, delay: delay(schedule.flagHonorPeriodAt), jobId: `honor-${deliveryId}` },
    ),
    queue.add(
      'reauthorize',
      { deliveryId },
      { ...RETRY, delay: delay(schedule.reauthorizeAt), jobId: `reauth-${deliveryId}` },
    ),
    queue.add(
      'expire-authorization',
      { deliveryId },
      { ...RETRY, delay: delay(schedule.expireAt), jobId: `expire-${deliveryId}` },
    ),
  ]);
}

export function schedulePayoutPoll(
  queue: Queue<LifecycleJobData>,
  deliveryId: string,
  attempt: number,
): Promise<unknown> {
  return queue.add(
    'poll-payout',
    { deliveryId, attempt },
    { ...RETRY, delay: PAYOUT_POLL_DELAY_MS, jobId: `poll-payout-${deliveryId}-${attempt}` },
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
