import { z } from 'zod';

// Only the fields we depend on are validated; unknown fields are dropped.

export const moneySchema = z.object({
  currency_code: z.string(),
  value: z.string(),
});

/** Payouts is a v1 API: money is `{ value, currency }`, not v2's `currency_code`. */
export const payoutMoneySchema = z.object({
  currency: z.string(),
  value: z.string(),
});

export const linkSchema = z.object({
  href: z.string(),
  rel: z.string(),
  method: z.string().optional(),
});

export const authorizationSchema = z.object({
  id: z.string(),
  status: z.string(),
  amount: moneySchema.optional(),
  expiration_time: z.string().optional(),
  create_time: z.string().optional(),
});

export const captureSchema = z.object({
  id: z.string(),
  status: z.string(),
  amount: moneySchema.optional(),
  final_capture: z.boolean().optional(),
  status_details: z.object({ reason: z.string().optional() }).optional(),
});

export const refundSchema = z.object({
  id: z.string(),
  status: z.string(),
  amount: moneySchema.optional(),
});

export const orderSchema = z.object({
  id: z.string(),
  status: z.string(),
  intent: z.string().optional(),
  links: z.array(linkSchema).default([]),
  purchase_units: z
    .array(
      z.object({
        reference_id: z.string().optional(),
        custom_id: z.string().optional(),
        amount: moneySchema.optional(),
        payments: z
          .object({
            authorizations: z.array(authorizationSchema).optional(),
            captures: z.array(captureSchema).optional(),
          })
          .optional(),
      }),
    )
    .default([]),
});

export const payoutBatchHeaderSchema = z.object({
  payout_batch_id: z.string(),
  batch_status: z.string(),
  sender_batch_header: z.object({ sender_batch_id: z.string().optional() }).optional(),
});

export const createPayoutResponseSchema = z.object({
  batch_header: payoutBatchHeaderSchema,
});

export const payoutItemSchema = z.object({
  payout_item_id: z.string(),
  transaction_id: z.string().optional(),
  transaction_status: z.string().optional(),
  payout_item: z
    .object({
      receiver: z.string().optional(),
      sender_item_id: z.string().optional(),
      amount: payoutMoneySchema.optional(),
    })
    .optional(),
  errors: z.object({ name: z.string().optional(), message: z.string().optional() }).optional(),
});

export const payoutBatchSchema = z.object({
  batch_header: payoutBatchHeaderSchema,
  items: z.array(payoutItemSchema).default([]),
});

export const verifyWebhookResponseSchema = z.object({
  verification_status: z.enum(['SUCCESS', 'FAILURE']),
});

export type PayPalOrder = z.infer<typeof orderSchema>;
export type PayPalAuthorization = z.infer<typeof authorizationSchema>;
export type PayPalCapture = z.infer<typeof captureSchema>;
export type PayPalRefund = z.infer<typeof refundSchema>;
export type PayPalPayoutCreated = z.infer<typeof createPayoutResponseSchema>;
export type PayPalPayoutBatch = z.infer<typeof payoutBatchSchema>;
