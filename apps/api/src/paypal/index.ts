import type { PayPalEnv } from '../env.js';
import type { Logger } from '../logger.js';
import { PayPalClient } from './client.js';

export * from './client.js';
export * from './errors.js';
export * from './idempotency.js';
export * from './schemas.js';

export function createPayPalClient(env: PayPalEnv, logger: Logger): PayPalClient {
  return new PayPalClient({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    environment: env.PAYPAL_ENVIRONMENT,
    logger,
  });
}
