/**
 * Sandbox smoke test: $1.00 payout to SANDBOX_PAYOUT_RECEIVER_EMAIL, polled to a final state.
 * Usage: pnpm smoke:payout
 */
import { requireEnv } from '../src/env.js';
import { createSmoke, pollUntil } from './lib.js';

const FINAL_BATCH = ['SUCCESS', 'DENIED', 'CANCELED'];
const FINAL_ITEM = [
  'SUCCESS',
  'FAILED',
  'RETURNED',
  'BLOCKED',
  'REFUNDED',
  'REVERSED',
  'UNCLAIMED',
  'DENIED',
];

const smoke = createSmoke('payout');
const { paypal, deliveryId } = smoke;

const receiver = await smoke.step(
  'SANDBOX_PAYOUT_RECEIVER_EMAIL set',
  async () => requireEnv('SANDBOX_PAYOUT_RECEIVER_EMAIL'),
  (e) => e,
);

const created = await smoke.step(
  'create payout $1.00',
  () =>
    paypal.createPayout({
      deliveryId,
      receiverEmail: receiver,
      amount: { cents: 100 },
      note: 'Smoke test rider payout',
    }),
  (r) =>
    `batch ${r.batch_header.payout_batch_id} → ${r.batch_header.batch_status} (not final; never mark RIDER_PAID from this)`,
);
const batchId = created.batch_header.payout_batch_id;

let last = '';
const batch = await smoke.step(
  'batch + item reach a final status',
  () =>
    pollUntil(
      () => paypal.getPayoutBatch(batchId, deliveryId),
      (b) =>
        FINAL_BATCH.includes(b.batch_header.batch_status) &&
        b.items.every((i) => FINAL_ITEM.includes(i.transaction_status ?? '')),
      {
        intervalMs: 5000,
        timeoutMs: 3 * 60 * 1000,
        onTick: (b) => {
          const now = `${b.batch_header.batch_status}/${b.items[0]?.transaction_status ?? '-'}`;
          if (now !== last) {
            last = now;
            smoke.print('batch/item', now);
          }
        },
      },
    ),
  (b) => `batch ${b.batch_header.batch_status}, item ${b.items[0]?.transaction_status ?? 'n/a'}`,
);

const item = batch.items[0];
await smoke.step(
  'payout item SUCCESS',
  async () => {
    if (item?.transaction_status !== 'SUCCESS') {
      throw new Error(
        `item status ${item?.transaction_status ?? 'missing'}${item?.errors?.name ? ` (${item.errors.name}: ${item.errors.message})` : ''}`,
      );
    }
    return item;
  },
  (i) => `item ${i.payout_item_id}, txn ${i.transaction_id ?? 'n/a'}`,
);

smoke.print('payout batch id', batchId);
smoke.print('payout item id', item?.payout_item_id ?? 'n/a');
console.log(
  '\n  If your webhook is registered, expect PAYMENT.PAYOUTSBATCH.SUCCESS and PAYMENT.PAYOUTS-ITEM.SUCCEEDED.',
);
smoke.finish();
