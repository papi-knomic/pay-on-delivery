import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createLogger } from '../logger.js';

// Works from src/db (tsx) and dist/db (node): both are two levels below the package root.
const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../drizzle');
// Arbitrary constant: serializes concurrent migrators (e.g. two containers starting at once).
const MIGRATION_LOCK_KEY = 727_001;

const log = createLogger(process.env.LOG_LEVEL ?? 'info');

async function main(): Promise<void> {
  const databaseUrl =
    process.env.DATABASE_URL ?? (await import('../env.js')).loadServerEnv().DATABASE_URL;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    log.info({ dir: MIGRATIONS_DIR }, 'running migrations');
    // Drizzle records applied migrations in drizzle.__drizzle_migrations, so re-running is a no-op.
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
    log.info('migrations complete');
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    await client.end();
  }
}

main().catch((err: unknown) => {
  log.fatal({ err }, 'migration failed');
  process.exit(1);
});
