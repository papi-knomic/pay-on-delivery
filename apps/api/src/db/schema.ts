import { DELIVERY_STATES } from '@pod/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// Money is always integer cents + a currency column. PayPal only gets USD (see CLAUDE.md).

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

const currency = () => text('currency').notNull().default('USD');
const usdOnly = (table: string, col: AnyPgColumn) =>
  check(`${table}_currency_usd`, sql`${col} = 'USD'`);

export const deliveryStatus = pgEnum('delivery_status', DELIVERY_STATES);

export const agentAction = pgEnum('agent_action', [
  'capture',
  'partial_capture',
  'request_evidence',
  'void',
  'escalate',
]);

export const paymentKind = pgEnum('payment_kind', ['authorization', 'capture', 'void', 'refund']);

export const merchants = pgTable('merchants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  ...timestamps,
});

export const riders = pgTable('riders', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  phone: text('phone'),
  /** Payout receiver (a sandbox personal account in the demo). */
  paypalEmail: text('paypal_email').notNull(),
  ...timestamps,
});

export const buyers = pgTable('buyers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  ...timestamps,
});

export const deliveries = pgTable(
  'deliveries',
  {
    id: text('id').primaryKey(),
    merchantId: text('merchant_id')
      .notNull()
      .references(() => merchants.id),
    buyerId: text('buyer_id')
      .notNull()
      .references(() => buyers.id),
    riderId: text('rider_id').references(() => riders.id),
    // Never update directly: go through transition() in @pod/shared.
    status: deliveryStatus('status').notNull().default('CREATED'),
    amountCents: integer('amount_cents').notNull(),
    riderFeeCents: integer('rider_fee_cents').notNull().default(0),
    capturedAmountCents: integer('captured_amount_cents'),
    currency: currency(),
    deliveryAddress: text('delivery_address').notNull(),
    deliveryLat: doublePrecision('delivery_lat'),
    deliveryLng: doublePrecision('delivery_lng'),
    otpHash: text('otp_hash'),
    paypalOrderId: text('paypal_order_id').unique(),
    /** Changes on every reauthorization; history lives in `payments`. */
    currentAuthorizationId: text('current_authorization_id'),
    /** ORIGINAL authorization time: anchors the day 3/4/29 lifecycle jobs. */
    authorizedAt: timestamp('authorized_at', { withTimezone: true }),
    honorPeriodFlaggedAt: timestamp('honor_period_flagged_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('deliveries_status_idx').on(t.status),
    index('deliveries_merchant_idx').on(t.merchantId),
    index('deliveries_rider_idx').on(t.riderId),
    usdOnly('deliveries', t.currency),
    check('deliveries_amount_nonneg', sql`${t.amountCents} >= 0 AND ${t.riderFeeCents} >= 0`),
    check(
      'deliveries_captured_lte_amount',
      sql`${t.capturedAmountCents} IS NULL OR ${t.capturedAmountCents} <= ${t.amountCents}`,
    ),
  ],
);

/** Tracking is stored here at shipment time and pushed to PayPal only after capture (needs capture_id). */
export const shipments = pgTable(
  'shipments',
  {
    id: text('id').primaryKey(),
    deliveryId: text('delivery_id')
      .notNull()
      .references(() => deliveries.id),
    carrier: text('carrier').notNull(),
    carrierNameOther: text('carrier_name_other'),
    trackingNumber: text('tracking_number').notNull(),
    pushedToPaypalAt: timestamp('pushed_to_paypal_at', { withTimezone: true }),
    paypalCaptureId: text('paypal_capture_id'),
    ...timestamps,
  },
  (t) => [index('shipments_delivery_idx').on(t.deliveryId)],
);

export const agentDecisions = pgTable(
  'agent_decisions',
  {
    id: text('id').primaryKey(),
    deliveryId: text('delivery_id')
      .notNull()
      .references(() => deliveries.id),
    /** What the model proposed. */
    proposedAction: agentAction('proposed_action').notNull(),
    /** What the policy layer allowed (may differ, e.g. forced escalate). */
    finalAction: agentAction('final_action').notNull(),
    confidence: real('confidence').notNull(),
    captureAmountCents: integer('capture_amount_cents'),
    reasoning: text('reasoning').notNull(),
    evidenceSummary: text('evidence_summary').notNull(),
    checks: jsonb('checks'),
    policyNotes: text('policy_notes'),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_decisions_delivery_idx').on(t.deliveryId)],
);

/** One row per PayPal payment object. Reauthorizations are new `authorization` rows linked by parentPaypalId. */
export const payments = pgTable(
  'payments',
  {
    id: text('id').primaryKey(),
    deliveryId: text('delivery_id')
      .notNull()
      .references(() => deliveries.id),
    kind: paymentKind('kind').notNull(),
    paypalId: text('paypal_id').notNull().unique(),
    parentPaypalId: text('parent_paypal_id'),
    attempt: integer('attempt').notNull().default(0),
    amountCents: integer('amount_cents'),
    currency: currency(),
    status: text('status').notNull(),
    finalCapture: boolean('final_capture'),
    /** Internal; never exposed in API resources. */
    requestId: text('request_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('payments_delivery_idx').on(t.deliveryId), usdOnly('payments', t.currency)],
);

export const payouts = pgTable(
  'payouts',
  {
    id: text('id').primaryKey(),
    deliveryId: text('delivery_id')
      .notNull()
      .references(() => deliveries.id),
    riderId: text('rider_id')
      .notNull()
      .references(() => riders.id),
    senderBatchId: text('sender_batch_id').notNull().unique(),
    paypalBatchId: text('paypal_batch_id').unique(),
    paypalItemId: text('paypal_item_id'),
    amountCents: integer('amount_cents').notNull(),
    currency: currency(),
    batchStatus: text('batch_status'),
    itemStatus: text('item_status'),
    ...timestamps,
  },
  (t) => [index('payouts_delivery_idx').on(t.deliveryId), usdOnly('payouts', t.currency)],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    /** PayPal event ID; the primary key is what makes processing idempotent. */
    eventId: text('event_id').primaryKey(),
    eventType: text('event_type').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    summary: text('summary'),
    /** Raw payload; internal only, never returned by the API. */
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [index('webhook_events_type_idx').on(t.eventType)],
);

export type Delivery = typeof deliveries.$inferSelect;
export type NewDelivery = typeof deliveries.$inferInsert;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;
