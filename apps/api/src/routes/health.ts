import { Resource } from '@kn0mic/reshaper';
import type { FastifyPluginAsync } from 'fastify';

export interface HealthChecks {
  db: () => Promise<void>;
  redis: () => Promise<void>;
}

const CHECK_TIMEOUT_MS = 2000;

async function probe(check: () => Promise<void>): Promise<'ok' | 'down'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), timeout]);
    return 'ok';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

export const healthRoutes: FastifyPluginAsync<{ checks: HealthChecks }> = async (
  app,
  { checks },
) => {
  app.get('/health', { logLevel: 'warn' }, async (_req, reply) => {
    const [db, redis] = await Promise.all([probe(checks.db), probe(checks.redis)]);
    const ok = db === 'ok' && redis === 'ok';
    return reply
      .code(ok ? 200 : 503)
      .send(Resource.wrap({ status: ok ? 'ok' : 'degraded', db, redis }));
  });
};
