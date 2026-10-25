import { sql } from 'drizzle-orm';
import { createLogger } from '../logger.js';
import { createDb } from './client.js';
import { merchants, riders } from './schema.js';

/**
 * Demo reference data. Fixed IDs + upserts, so re-running is safe and IDs stay stable for the
 * README and the demo script. Riders are paid to SANDBOX_PAYOUT_RECEIVER_EMAIL (a sandbox
 * personal account) so payouts actually land somewhere.
 */

const log = createLogger(process.env.LOG_LEVEL ?? 'info');

export const DEMO_MERCHANTS = [
  { id: 'mer_bolanle', name: 'Bolanle Provisions', email: 'orders@bolanle.example.com' },
  { id: 'mer_gadgethub', name: 'Lekki Gadget Hub', email: 'sales@gadgethub.example.com' },
  { id: 'mer_ofada', name: 'Ofada Kitchen', email: 'hello@ofada.example.com' },
] as const;

const DEMO_RIDERS = [
  { id: 'rdr_erakpoweri', name: 'Efe Erakpoweri', phone: '+234 803 555 0142' },
  { id: 'rdr_kemi', name: 'Kemi Adeyemi', phone: '+234 806 555 0197' },
  { id: 'rdr_ifeanyi', name: 'Ifeanyi Okoro', phone: '+234 809 555 0163' },
] as const;

async function main(): Promise<void> {
  const env = (await import('../env.js')).loadServerEnv();
  const payoutEmail = process.env.SANDBOX_PAYOUT_RECEIVER_EMAIL;
  if (!payoutEmail) {
    log.warn('SANDBOX_PAYOUT_RECEIVER_EMAIL is not set: rider payouts will fail until it is');
  }
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    await db
      .insert(merchants)
      .values([...DEMO_MERCHANTS])
      .onConflictDoUpdate({
        target: merchants.id,
        set: { name: sql`excluded.name`, email: sql`excluded.email` },
      });
    await db
      .insert(riders)
      .values(
        DEMO_RIDERS.map((r) => ({
          ...r,
          paypalEmail: payoutEmail ?? 'rider@personal.example.com',
        })),
      )
      .onConflictDoUpdate({
        target: riders.id,
        set: {
          name: sql`excluded.name`,
          phone: sql`excluded.phone`,
          paypalEmail: sql`excluded.paypal_email`,
        },
      });
    log.info(
      { merchants: DEMO_MERCHANTS.map((m) => m.id), riders: DEMO_RIDERS.map((r) => r.id) },
      'seeded',
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  log.fatal({ err }, 'seed failed');
  process.exit(1);
});
