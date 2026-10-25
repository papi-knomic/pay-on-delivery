import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { AI_PROVIDERS, type AiConfig } from './agent/model.js';

const ROOT_ENV_FILE = resolve(import.meta.dirname, '../../../.env');
const ROOT_UPLOAD_DIR = resolve(import.meta.dirname, '../../../uploads');

/**
 * Loads the repo-root .env for local dev. Real environment variables always win,
 * so in containers (no .env file) nothing changes.
 */
function loadDotEnv(): void {
  if (!existsSync(ROOT_ENV_FILE)) return;
  const parsed = parseEnv(readFileSync(ROOT_ENV_FILE, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined && value !== undefined) {
      process.env[key] = value;
    }
  }
}

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

export const paypalEnvSchema = z.object({
  PAYPAL_CLIENT_ID: z.string().min(1, 'PAYPAL_CLIENT_ID is required'),
  PAYPAL_CLIENT_SECRET: z.string().min(1, 'PAYPAL_CLIENT_SECRET is required'),
  // Sandbox only (see CLAUDE.md). Anything else is rejected at startup.
  PAYPAL_ENVIRONMENT: z.literal('SANDBOX').default('SANDBOX'),
  PAYPAL_WEBHOOK_ID: optionalString,
  PUBLIC_BASE_URL: z.preprocess(emptyToUndefined, z.url().default('http://localhost:3000')),
});

const aiEnvShape = {
  AI_PROVIDER: z.preprocess(emptyToUndefined, z.enum(AI_PROVIDERS).optional()),
  AI_MODEL: optionalString,
  AI_API_KEY: optionalString,
};
const aiEnvSchema = z.object(aiEnvShape);

export const serverEnvSchema = paypalEnvSchema.extend({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Directory with the built web app. Defaults to apps/api/public (populated in the Docker image). */
  WEB_DIST_DIR: optionalString,
  /** Rider photos. A Docker volume in production; ./uploads at the repo root in dev. */
  UPLOAD_DIR: z.preprocess(emptyToUndefined, z.string().default(ROOT_UPLOAD_DIR)),
  ...aiEnvShape,
});

export type PayPalEnv = z.infer<typeof paypalEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

function parse<S extends z.ZodType>(schema: S): z.infer<S> {
  loadDotEnv();
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return result.data;
}

export const loadPayPalEnv = (): PayPalEnv => parse(paypalEnvSchema);
export const loadServerEnv = (): ServerEnv => parse(serverEnvSchema);

/** Null when any AI variable is missing: the app still runs, and the agent escalates everything. */
export function aiConfigFrom(env: z.infer<typeof aiEnvSchema>): AiConfig | null {
  if (!env.AI_PROVIDER || !env.AI_MODEL || !env.AI_API_KEY) return null;
  return { provider: env.AI_PROVIDER, model: env.AI_MODEL, apiKey: env.AI_API_KEY };
}

export const loadAiConfig = (): AiConfig | null => aiConfigFrom(parse(aiEnvSchema));

/** For scripts that need extra variables (e.g. SANDBOX_PAYOUT_RECEIVER_EMAIL). */
export function requireEnv(name: string): string {
  loadDotEnv();
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (set it in .env)`);
  return value;
}
