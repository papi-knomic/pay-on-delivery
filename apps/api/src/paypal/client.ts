import { centsToDecimal, PAYPAL_CURRENCY, type PayPalCurrency } from '@pod/shared';
import type { z } from 'zod';
import type { Logger } from '../logger.js';
import { PayPalError, PayPalResponseShapeError, type PayPalErrorDetail } from './errors.js';
import { paypalRequestId, type PayPalAction } from './idempotency.js';
import {
  authorizationSchema,
  captureSchema,
  createPayoutResponseSchema,
  orderSchema,
  payoutBatchSchema,
  refundSchema,
  verifyWebhookResponseSchema,
  type PayPalAuthorization,
  type PayPalCapture,
  type PayPalOrder,
  type PayPalPayoutBatch,
  type PayPalPayoutCreated,
  type PayPalRefund,
} from './schemas.js';
import { TokenProvider } from './token.js';

/** Sandbox only. There is deliberately no way to point this client at live PayPal. */
export const PAYPAL_SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  environment: 'SANDBOX';
  logger: Logger;
  fetch?: typeof fetch;
}

export interface RequestOptions<S extends z.ZodType> {
  method: 'GET' | 'POST';
  path: string;
  schema: S;
  /** JSON-serializable body, or a pre-serialized string (used for webhook verification). */
  body?: unknown;
  /** PayPal-Request-Id; required on money-moving POSTs. */
  requestId?: string;
  deliveryId?: string;
  action?: string;
}

export interface Amount {
  cents: number;
  currency?: PayPalCurrency;
}

const money = ({ cents, currency = PAYPAL_CURRENCY }: Amount) => ({
  currency_code: currency,
  value: centsToDecimal(cents),
});

export const WEBHOOK_SIGNATURE_HEADERS = [
  'paypal-auth-algo',
  'paypal-cert-url',
  'paypal-transmission-id',
  'paypal-transmission-sig',
  'paypal-transmission-time',
] as const;

export class PayPalClient {
  readonly baseUrl = PAYPAL_SANDBOX_BASE_URL;
  private readonly tokens: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;

  constructor(opts: PayPalClientOptions) {
    if (opts.environment !== 'SANDBOX') {
      throw new Error('Only the PayPal SANDBOX environment is supported');
    }
    this.fetchImpl = opts.fetch ?? fetch;
    this.log = opts.logger.child({ component: 'paypal' });
    this.tokens = new TokenProvider({
      baseUrl: this.baseUrl,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      fetch: this.fetchImpl,
    });
  }

  // ---------------------------------------------------------------- Orders

  /** Create an AUTHORIZE-intent order. PayPal wallet only: reauthorization only works for PayPal-account payments. */
  createOrder(input: {
    deliveryId: string;
    amount: Amount;
    description?: string;
    returnUrl: string;
    cancelUrl: string;
    brandName?: string;
    /** Shown to the buyer on the PayPal page. Items + shipping must add up to `amount`. */
    items?: readonly { name: string; quantity: number; unitCents: number }[];
    shippingCents?: number;
  }): Promise<PayPalOrder> {
    let breakdown: Record<string, unknown> | undefined;
    if (input.items?.length) {
      const itemTotal = input.items.reduce((sum, i) => sum + i.quantity * i.unitCents, 0);
      const shipping = input.shippingCents ?? 0;
      if (itemTotal + shipping !== input.amount.cents) {
        return Promise.reject(
          new RangeError(
            `Order items (${itemTotal}) + shipping (${shipping}) must equal the amount (${input.amount.cents})`,
          ),
        );
      }
      breakdown = {
        item_total: money({ cents: itemTotal }),
        ...(shipping > 0 && { shipping: money({ cents: shipping }) }),
      };
    }
    return this.request({
      method: 'POST',
      path: '/v2/checkout/orders',
      requestId: paypalRequestId(input.deliveryId, 'create-order'),
      deliveryId: input.deliveryId,
      action: 'create-order',
      schema: orderSchema,
      body: {
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            reference_id: input.deliveryId,
            custom_id: input.deliveryId,
            description: input.description,
            amount: breakdown ? { ...money(input.amount), breakdown } : money(input.amount),
            ...(breakdown && {
              items: input.items?.map((i) => ({
                name: i.name.slice(0, 127),
                quantity: String(i.quantity),
                unit_amount: money({ cents: i.unitCents }),
              })),
            }),
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
              brand_name: input.brandName,
              user_action: 'CONTINUE',
            },
          },
        },
      },
    });
  }

  getOrder(orderId: string, deliveryId?: string): Promise<PayPalOrder> {
    return this.request({
      method: 'GET',
      path: `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
      schema: orderSchema,
      deliveryId,
      action: 'get-order',
    });
  }

  /** Authorize a buyer-approved order. Returns the order; the authorization is at purchase_units[0].payments.authorizations[0]. */
  authorizeOrder(input: { orderId: string; deliveryId: string }): Promise<PayPalOrder> {
    return this.request({
      method: 'POST',
      path: `/v2/checkout/orders/${encodeURIComponent(input.orderId)}/authorize`,
      requestId: paypalRequestId(input.deliveryId, 'authorize'),
      deliveryId: input.deliveryId,
      action: 'authorize',
      schema: orderSchema,
      body: {},
    });
  }

  /**
   * Push tracking to PayPal. Requires the capture ID (from the authorization-capture response),
   * so this only works after capture. Tracking is stored in our DB until then.
   */
  addTracking(input: {
    orderId: string;
    deliveryId: string;
    captureId: string;
    trackingNumber: string;
    carrier: string;
    carrierNameOther?: string;
    notifyPayer?: boolean;
  }): Promise<PayPalOrder> {
    return this.request({
      method: 'POST',
      path: `/v2/checkout/orders/${encodeURIComponent(input.orderId)}/track`,
      requestId: paypalRequestId(input.deliveryId, 'track'),
      deliveryId: input.deliveryId,
      action: 'track',
      schema: orderSchema,
      body: {
        capture_id: input.captureId,
        tracking_number: input.trackingNumber,
        carrier: input.carrier,
        carrier_name_other: input.carrierNameOther,
        notify_payer: input.notifyPayer ?? false,
      },
    });
  }

  // ---------------------------------------------------------- Authorizations

  getAuthorization(authorizationId: string, deliveryId?: string): Promise<PayPalAuthorization> {
    return this.request({
      method: 'GET',
      path: `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`,
      schema: authorizationSchema,
      deliveryId,
      action: 'get-authorization',
    });
  }

  /**
   * Capture an authorization, fully (omit `amount`) or partially.
   * Always sends final_capture: true so PayPal releases any uncaptured remainder (no void needed).
   */
  captureAuthorization(input: {
    authorizationId: string;
    deliveryId: string;
    amount?: Amount;
    invoiceId?: string;
  }): Promise<PayPalCapture> {
    return this.request({
      method: 'POST',
      path: `/v2/payments/authorizations/${encodeURIComponent(input.authorizationId)}/capture`,
      requestId: paypalRequestId(input.deliveryId, 'capture'),
      deliveryId: input.deliveryId,
      action: 'capture',
      schema: captureSchema,
      body: {
        final_capture: true,
        ...(input.amount ? { amount: money(input.amount) } : {}),
        ...(input.invoiceId ? { invoice_id: input.invoiceId } : {}),
      },
    });
  }

  voidAuthorization(input: {
    authorizationId: string;
    deliveryId: string;
  }): Promise<PayPalAuthorization> {
    return this.request({
      method: 'POST',
      path: `/v2/payments/authorizations/${encodeURIComponent(input.authorizationId)}/void`,
      requestId: paypalRequestId(input.deliveryId, 'void'),
      deliveryId: input.deliveryId,
      action: 'void',
      schema: authorizationSchema,
    });
  }

  /**
   * Reauthorize after the 3-day honor period (days 4–29). Returns a NEW authorization ID;
   * store it as the delivery's current authorization. `attempt` keeps each reauth's idempotency key distinct.
   */
  reauthorize(input: {
    authorizationId: string;
    deliveryId: string;
    attempt: number;
    amount?: Amount;
  }): Promise<PayPalAuthorization> {
    return this.request({
      method: 'POST',
      path: `/v2/payments/authorizations/${encodeURIComponent(input.authorizationId)}/reauthorize`,
      requestId: paypalRequestId(input.deliveryId, 'reauthorize', input.attempt),
      deliveryId: input.deliveryId,
      action: 'reauthorize',
      schema: authorizationSchema,
      body: input.amount ? { amount: money(input.amount) } : {},
    });
  }

  // ---------------------------------------------------------------- Captures

  /** Human override after capture. Omit `amount` for a full refund. */
  refundCapture(input: {
    captureId: string;
    deliveryId: string;
    amount?: Amount;
  }): Promise<PayPalRefund> {
    return this.request({
      method: 'POST',
      path: `/v2/payments/captures/${encodeURIComponent(input.captureId)}/refund`,
      requestId: paypalRequestId(input.deliveryId, 'refund'),
      deliveryId: input.deliveryId,
      action: 'refund',
      schema: refundSchema,
      body: input.amount ? { amount: money(input.amount) } : {},
    });
  }

  // ----------------------------------------------------------------- Payouts

  /**
   * Pay the rider. The response is usually PENDING; RIDER_PAID is set only from the
   * payout item webhook or the polling fallback, never from this response.
   */
  createPayout(input: {
    deliveryId: string;
    receiverEmail: string;
    amount: Amount;
    note?: string;
    emailSubject?: string;
  }): Promise<PayPalPayoutCreated> {
    const key = paypalRequestId(input.deliveryId, 'payout');
    return this.request({
      method: 'POST',
      path: '/v1/payments/payouts',
      requestId: key,
      deliveryId: input.deliveryId,
      action: 'payout',
      schema: createPayoutResponseSchema,
      body: {
        sender_batch_header: {
          // PayPal also de-duplicates on sender_batch_id (30 days).
          sender_batch_id: key,
          email_subject: input.emailSubject ?? 'You have a delivery payout',
        },
        items: [
          {
            recipient_type: 'EMAIL',
            receiver: input.receiverEmail,
            amount: {
              value: centsToDecimal(input.amount.cents),
              currency: input.amount.currency ?? PAYPAL_CURRENCY,
            },
            sender_item_id: input.deliveryId,
            note: input.note ?? `Delivery ${input.deliveryId}`,
          },
        ],
      },
    });
  }

  getPayoutBatch(batchId: string, deliveryId?: string): Promise<PayPalPayoutBatch> {
    return this.request({
      method: 'GET',
      path: `/v1/payments/payouts/${encodeURIComponent(batchId)}`,
      schema: payoutBatchSchema,
      deliveryId,
      action: 'get-payout-batch',
    });
  }

  // ---------------------------------------------------------------- Webhooks

  /**
   * Verify a webhook via PayPal's API. The raw body is spliced in verbatim: re-serializing
   * parsed JSON can change it and make verification fail.
   */
  async verifyWebhookSignature(input: {
    webhookId: string;
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
  }): Promise<boolean> {
    const header = (name: string) => {
      const v = input.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const values = WEBHOOK_SIGNATURE_HEADERS.map(header);
    if (values.some((v) => !v)) {
      this.log.warn('webhook missing PayPal signature headers');
      return false;
    }
    const [authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime] = values;
    const envelope = JSON.stringify({
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: input.webhookId,
    });
    const body = `${envelope.slice(0, -1)},"webhook_event":${input.rawBody}}`;
    const res = await this.request({
      method: 'POST',
      path: '/v1/notifications/verify-webhook-signature',
      schema: verifyWebhookResponseSchema,
      body,
      action: 'verify-webhook',
    });
    return res.verification_status === 'SUCCESS';
  }

  // ------------------------------------------------------------------ Core

  /** Low-level call with auth, idempotency, logging and response validation. Prefer the typed methods. */
  async request<S extends z.ZodType>(opts: RequestOptions<S>): Promise<z.infer<S>> {
    const started = Date.now();
    const logCtx = {
      deliveryId: opts.deliveryId,
      action: opts.action,
      method: opts.method,
      path: opts.path,
      requestId: opts.requestId,
    };

    const send = async (): Promise<Response> => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await this.tokens.get()}`,
        Accept: 'application/json',
        Prefer: 'return=representation',
      };
      if (opts.requestId) headers['PayPal-Request-Id'] = opts.requestId;
      let body: string | undefined;
      if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      } else if (opts.method === 'POST') {
        headers['Content-Type'] = 'application/json';
      }
      return this.fetchImpl(`${this.baseUrl}${opts.path}`, { method: opts.method, headers, body });
    };

    let res = await send();
    if (res.status === 401) {
      // Token revoked or expired early: refresh once and retry with the same PayPal-Request-Id.
      this.tokens.invalidate();
      res = await send();
    }

    const debugId = res.headers.get('paypal-debug-id') ?? undefined;
    const text = await res.text();
    const json: unknown = text ? safeJson(text) : {};
    const durationMs = Date.now() - started;

    if (!res.ok) {
      const err = json as { name?: string; message?: string; details?: PayPalErrorDetail[] };
      this.log.warn(
        {
          ...logCtx,
          status: res.status,
          debugId,
          issue: err.details?.[0]?.issue ?? err.name,
          durationMs,
        },
        'paypal call failed',
      );
      throw new PayPalError(
        `PayPal ${opts.method} ${opts.path} failed (${res.status}): ${err.message ?? res.statusText}`,
        res.status,
        err.name,
        debugId,
        err.details ?? [],
      );
    }

    const parsed = opts.schema.safeParse(json);
    if (!parsed.success) {
      this.log.error(
        { ...logCtx, status: res.status, debugId },
        'unexpected paypal response shape',
      );
      throw new PayPalResponseShapeError(opts.path, parsed.error.message);
    }
    this.log.info({ ...logCtx, status: res.status, debugId, durationMs }, 'paypal call');
    return parsed.data;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/** Approval URL from an order's HATEOAS links (`payer-action` with payment_source, `approve` otherwise). */
export function approvalUrl(order: PayPalOrder): string | undefined {
  return order.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
}

export function firstAuthorization(order: PayPalOrder): PayPalAuthorization | undefined {
  return order.purchase_units[0]?.payments?.authorizations?.[0];
}

export type { PayPalAction };
