import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { PayPalClient, PAYPAL_SANDBOX_BASE_URL } from './client.js';
import { PayPalError } from './errors.js';
import { paypalRequestId } from './idempotency.js';
import { TokenProvider } from './token.js';

const silent = pino({ level: 'silent' });

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

interface Call {
  url: string;
  init: RequestInit;
}

/** Fake PayPal: answers OAuth with a token and routes everything else through `handler`. */
function fakePayPal(handler: (call: Call) => Response, tokenTtlSeconds = 32_400) {
  const calls: Call[] = [];
  let tokenCount = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, init });
    if (url.endsWith('/v1/oauth2/token')) {
      tokenCount += 1;
      return json({ access_token: `token-${tokenCount}`, expires_in: tokenTtlSeconds });
    }
    return handler({ url, init });
  });
  const apiCalls = () => calls.filter((c) => !c.url.endsWith('/v1/oauth2/token'));
  const tokenCalls = () => calls.filter((c) => c.url.endsWith('/v1/oauth2/token'));
  return { fetchMock, calls, apiCalls, tokenCalls };
}

const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];
const body = (init: RequestInit) => JSON.parse(init.body as string) as Record<string, unknown>;

function client(fetchMock: typeof fetch) {
  return new PayPalClient({
    clientId: 'id',
    clientSecret: 'secret',
    environment: 'SANDBOX',
    logger: silent,
    fetch: fetchMock,
  });
}

describe('TokenProvider', () => {
  it('caches the token and refreshes before expiry', async () => {
    let now = 0;
    const { fetchMock, tokenCalls } = fakePayPal(() => json({}), 3600);
    const tokens = new TokenProvider({
      baseUrl: PAYPAL_SANDBOX_BASE_URL,
      clientId: 'id',
      clientSecret: 'secret',
      fetch: fetchMock,
      now: () => now,
    });

    expect(await tokens.get()).toBe('token-1');
    now = 50 * 60 * 1000; // 50 min: still inside the 55-minute refresh window
    expect(await tokens.get()).toBe('token-1');
    expect(tokenCalls()).toHaveLength(1);

    now = 56 * 60 * 1000; // past (3600s - 5min margin)
    expect(await tokens.get()).toBe('token-2');
    expect(tokenCalls()).toHaveLength(2);
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    const { fetchMock, tokenCalls } = fakePayPal(() => json({}));
    const tokens = new TokenProvider({
      baseUrl: PAYPAL_SANDBOX_BASE_URL,
      clientId: 'id',
      clientSecret: 'secret',
      fetch: fetchMock,
    });
    const results = await Promise.all([tokens.get(), tokens.get(), tokens.get()]);
    expect(results).toEqual(['token-1', 'token-1', 'token-1']);
    expect(tokenCalls()).toHaveLength(1);
  });

  it('sends client credentials as HTTP basic auth', async () => {
    const { fetchMock, tokenCalls } = fakePayPal(() => json({}));
    await new TokenProvider({
      baseUrl: PAYPAL_SANDBOX_BASE_URL,
      clientId: 'id',
      clientSecret: 'secret',
      fetch: fetchMock,
    }).get();
    const init = tokenCalls()[0]!.init;
    expect(header(init, 'Authorization')).toBe(
      `Basic ${Buffer.from('id:secret').toString('base64')}`,
    );
    expect(init.body).toBe('grant_type=client_credentials');
  });
});

describe('PayPalClient', () => {
  it('refuses non-sandbox environments', () => {
    expect(
      () =>
        new PayPalClient({
          clientId: 'id',
          clientSecret: 'secret',
          environment: 'LIVE' as 'SANDBOX',
          logger: silent,
        }),
    ).toThrow(/SANDBOX/);
  });

  it('reuses one token across calls and always hits the sandbox host', async () => {
    const { fetchMock, apiCalls, tokenCalls } = fakePayPal(() =>
      json({ id: 'AUTH-1', status: 'CREATED' }),
    );
    const paypal = client(fetchMock);
    await paypal.getAuthorization('AUTH-1');
    await paypal.getAuthorization('AUTH-1');
    expect(tokenCalls()).toHaveLength(1);
    for (const call of apiCalls()) {
      expect(call.url.startsWith('https://api-m.sandbox.paypal.com/')).toBe(true);
      expect(header(call.init, 'Authorization')).toBe('Bearer token-1');
    }
  });

  it('createOrder sends AUTHORIZE intent, PayPal wallet source, decimal USD and an idempotency key', async () => {
    const { fetchMock, apiCalls } = fakePayPal(() =>
      json({
        id: 'ORDER-1',
        status: 'PAYER_ACTION_REQUIRED',
        links: [
          { href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-1', rel: 'payer-action' },
        ],
      }),
    );
    const order = await client(fetchMock).createOrder({
      deliveryId: 'dlv_1',
      amount: { cents: 1250 },
      returnUrl: 'https://example.com/ok',
      cancelUrl: 'https://example.com/cancel',
    });
    expect(order.id).toBe('ORDER-1');
    const { url, init } = apiCalls()[0]!;
    expect(url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v2/checkout/orders`);
    expect(header(init, 'PayPal-Request-Id')).toBe('dlv_1:create-order');
    const sent = body(init) as {
      intent: string;
      purchase_units: Array<{ amount: unknown; custom_id: string }>;
      payment_source: { paypal: unknown };
    };
    expect(sent.intent).toBe('AUTHORIZE');
    expect(sent.purchase_units[0]!.amount).toEqual({ currency_code: 'USD', value: '12.50' });
    expect(sent.purchase_units[0]!.custom_id).toBe('dlv_1');
    expect(sent.payment_source.paypal).toBeDefined();
  });

  it('createOrder sends line items with a breakdown that adds up', async () => {
    const { fetchMock, apiCalls } = fakePayPal(() =>
      json({ id: 'ORDER-2', status: 'PAYER_ACTION_REQUIRED', links: [] }),
    );
    await client(fetchMock).createOrder({
      deliveryId: 'dlv_2',
      amount: { cents: 2500 },
      returnUrl: 'https://example.com/ok',
      cancelUrl: 'https://example.com/cancel',
      items: [
        { name: 'Blender', quantity: 1, unitCents: 1800 },
        { name: 'Plantain chips', quantity: 2, unitCents: 200 },
      ],
      shippingCents: 300,
    });
    const unit = (body(apiCalls()[0]!.init) as { purchase_units: Array<Record<string, unknown>> })
      .purchase_units[0]!;
    expect(unit.amount).toEqual({
      currency_code: 'USD',
      value: '25.00',
      breakdown: {
        item_total: { currency_code: 'USD', value: '22.00' },
        shipping: { currency_code: 'USD', value: '3.00' },
      },
    });
    expect(unit.items).toEqual([
      { name: 'Blender', quantity: '1', unit_amount: { currency_code: 'USD', value: '18.00' } },
      {
        name: 'Plantain chips',
        quantity: '2',
        unit_amount: { currency_code: 'USD', value: '2.00' },
      },
    ]);
  });

  it('createOrder refuses items that do not add up to the amount', async () => {
    const { fetchMock, apiCalls } = fakePayPal(() => json({}));
    await expect(
      client(fetchMock).createOrder({
        deliveryId: 'dlv_3',
        amount: { cents: 2500 },
        returnUrl: 'https://example.com/ok',
        cancelUrl: 'https://example.com/cancel',
        items: [{ name: 'Blender', quantity: 1, unitCents: 1800 }],
      }),
    ).rejects.toThrow(RangeError);
    expect(apiCalls()).toHaveLength(0);
  });

  it('captureAuthorization always sends final_capture: true, with and without a partial amount', async () => {
    const { fetchMock, apiCalls } = fakePayPal(() => json({ id: 'CAP-1', status: 'COMPLETED' }));
    const paypal = client(fetchMock);
    await paypal.captureAuthorization({
      authorizationId: 'AUTH-1',
      deliveryId: 'dlv_1',
      amount: { cents: 600 },
    });
    await paypal.captureAuthorization({ authorizationId: 'AUTH-1', deliveryId: 'dlv_2' });

    const [partial, full] = apiCalls();
    expect(partial!.url).toBe(
      `${PAYPAL_SANDBOX_BASE_URL}/v2/payments/authorizations/AUTH-1/capture`,
    );
    expect(body(partial!.init)).toEqual({
      final_capture: true,
      amount: { currency_code: 'USD', value: '6.00' },
    });
    expect(body(full!.init)).toEqual({ final_capture: true });
  });

  it('retries reuse the same PayPal-Request-Id', async () => {
    let attempt = 0;
    const { fetchMock, apiCalls } = fakePayPal(() => {
      attempt += 1;
      return attempt === 1
        ? json({ name: 'INTERNAL_SERVER_ERROR', message: 'boom' }, 500)
        : json({ id: 'CAP-1', status: 'COMPLETED' });
    });
    const paypal = client(fetchMock);
    const input = { authorizationId: 'AUTH-1', deliveryId: 'dlv_9', amount: { cents: 100 } };
    await expect(paypal.captureAuthorization(input)).rejects.toBeInstanceOf(PayPalError);
    await paypal.captureAuthorization(input);
    const keys = apiCalls().map((c) => header(c.init, 'PayPal-Request-Id'));
    expect(keys).toEqual(['dlv_9:capture', 'dlv_9:capture']);
  });

  it('refreshes the token once on 401 and resends with the same idempotency key', async () => {
    let attempt = 0;
    const { fetchMock, apiCalls, tokenCalls } = fakePayPal(() => {
      attempt += 1;
      return attempt === 1
        ? json({ error: 'invalid_token' }, 401)
        : json({ id: 'AUTH-1', status: 'VOIDED' });
    });
    const res = await client(fetchMock).voidAuthorization({
      authorizationId: 'AUTH-1',
      deliveryId: 'dlv_3',
    });
    expect(res.status).toBe('VOIDED');
    expect(tokenCalls()).toHaveLength(2);
    const [first, second] = apiCalls();
    expect(header(first!.init, 'Authorization')).toBe('Bearer token-1');
    expect(header(second!.init, 'Authorization')).toBe('Bearer token-2');
    expect(header(second!.init, 'PayPal-Request-Id')).toBe('dlv_3:void');
  });

  it('reauthorize keys include the attempt number', async () => {
    const { fetchMock, apiCalls } = fakePayPal(() => json({ id: 'AUTH-2', status: 'CREATED' }));
    const res = await client(fetchMock).reauthorize({
      authorizationId: 'AUTH-1',
      deliveryId: 'dlv_4',
      attempt: 1,
    });
    expect(res.id).toBe('AUTH-2');
    expect(header(apiCalls()[0]!.init, 'PayPal-Request-Id')).toBe('dlv_4:reauthorize:1');
  });

  it('createPayout uses the idempotency key as sender_batch_id', async () => {
    const { fetchMock, apiCalls } = fakePayPal(() =>
      json({ batch_header: { payout_batch_id: 'BATCH-1', batch_status: 'PENDING' } }, 201),
    );
    const res = await client(fetchMock).createPayout({
      deliveryId: 'dlv_5',
      receiverEmail: 'rider@example.com',
      amount: { cents: 150 },
    });
    expect(res.batch_header.batch_status).toBe('PENDING');
    const { init } = apiCalls()[0]!;
    expect(header(init, 'PayPal-Request-Id')).toBe('dlv_5:payout');
    const sent = body(init) as {
      sender_batch_header: { sender_batch_id: string };
      items: Array<{ amount: unknown; receiver: string }>;
    };
    expect(sent.sender_batch_header.sender_batch_id).toBe('dlv_5:payout');
    expect(sent.items[0]!.amount).toEqual({ value: '1.50', currency: 'USD' });
  });

  it('getPayoutBatch parses v1 money ({ value, currency })', async () => {
    const { fetchMock } = fakePayPal(() =>
      json({
        batch_header: { payout_batch_id: 'BATCH-1', batch_status: 'SUCCESS' },
        items: [
          {
            payout_item_id: 'ITEM-1',
            transaction_status: 'SUCCESS',
            payout_item: {
              receiver: 'rider@example.com',
              amount: { value: '1.00', currency: 'USD' },
            },
          },
        ],
      }),
    );
    const res = await client(fetchMock).getPayoutBatch('BATCH-1', 'dlv_5');
    expect(res.items[0]!.payout_item?.amount).toEqual({ value: '1.00', currency: 'USD' });
  });

  it('addTracking sends the capture_id', async () => {
    const { fetchMock, apiCalls } = fakePayPal(() => json({ id: 'ORDER-1', status: 'COMPLETED' }));
    await client(fetchMock).addTracking({
      orderId: 'ORDER-1',
      deliveryId: 'dlv_6',
      captureId: 'CAP-1',
      trackingNumber: 'TRK1',
      carrier: 'OTHER',
      carrierNameOther: 'Rider',
    });
    expect(body(apiCalls()[0]!.init)).toMatchObject({
      capture_id: 'CAP-1',
      tracking_number: 'TRK1',
      carrier: 'OTHER',
    });
  });

  it('surfaces PayPal error details and debug id', async () => {
    const { fetchMock } = fakePayPal(() =>
      json(
        {
          name: 'UNPROCESSABLE_ENTITY',
          message: 'The requested action could not be performed.',
          details: [{ issue: 'AUTHORIZATION_ALREADY_CAPTURED' }],
        },
        422,
        { 'paypal-debug-id': 'dbg123' },
      ),
    );
    const err = await client(fetchMock)
      .voidAuthorization({ authorizationId: 'AUTH-1', deliveryId: 'dlv_7' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).status).toBe(422);
    expect((err as PayPalError).issue).toBe('AUTHORIZATION_ALREADY_CAPTURED');
    expect((err as PayPalError).debugId).toBe('dbg123');
  });

  it('rejects responses missing fields we depend on', async () => {
    const { fetchMock } = fakePayPal(() => json({ status: 'COMPLETED' }));
    await expect(
      client(fetchMock).captureAuthorization({ authorizationId: 'A', deliveryId: 'dlv_8' }),
    ).rejects.toThrow(/Unexpected PayPal response shape/);
  });

  describe('verifyWebhookSignature', () => {
    const headers = {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem',
      'paypal-transmission-id': 'tx-1',
      'paypal-transmission-sig': 'sig',
      'paypal-transmission-time': '2026-10-06T00:00:00Z',
    };

    it('splices the raw body verbatim into the verification request', async () => {
      const { fetchMock, apiCalls } = fakePayPal(() => json({ verification_status: 'SUCCESS' }));
      // Odd spacing and key order on purpose: must not be re-serialized.
      const rawBody =
        '{"id":"WH-1",  "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAP-1"}}';
      const ok = await client(fetchMock).verifyWebhookSignature({
        webhookId: 'WHID',
        headers,
        rawBody,
      });
      expect(ok).toBe(true);
      const sent = apiCalls()[0]!.init.body as string;
      expect(sent.endsWith(`"webhook_event":${rawBody}}`)).toBe(true);
      expect(JSON.parse(sent)).toMatchObject({ webhook_id: 'WHID', transmission_id: 'tx-1' });
    });

    it('returns false on FAILURE', async () => {
      const { fetchMock } = fakePayPal(() => json({ verification_status: 'FAILURE' }));
      expect(
        await client(fetchMock).verifyWebhookSignature({
          webhookId: 'WHID',
          headers,
          rawBody: '{}',
        }),
      ).toBe(false);
    });

    it('returns false without calling PayPal when signature headers are missing', async () => {
      const { fetchMock, apiCalls } = fakePayPal(() => json({ verification_status: 'SUCCESS' }));
      expect(
        await client(fetchMock).verifyWebhookSignature({
          webhookId: 'WHID',
          headers: {},
          rawBody: '{}',
        }),
      ).toBe(false);
      expect(apiCalls()).toHaveLength(0);
    });
  });
});

describe('paypalRequestId', () => {
  it('is deterministic per delivery + action', () => {
    expect(paypalRequestId('dlv_123', 'capture')).toBe('dlv_123:capture');
    expect(paypalRequestId('dlv_123', 'capture')).toBe(paypalRequestId('dlv_123', 'capture'));
    expect(paypalRequestId('dlv_123', 'reauthorize', 2)).toBe('dlv_123:reauthorize:2');
    expect(() => paypalRequestId('', 'capture')).toThrow();
  });
});
