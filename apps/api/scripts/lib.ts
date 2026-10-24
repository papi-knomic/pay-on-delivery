import { pino } from 'pino';
import { loadPayPalEnv, type PayPalEnv } from '../src/env.js';
import {
  PayPalError,
  approvalUrl,
  createPayPalClient,
  firstAuthorization,
  type PayPalClient,
} from '../src/paypal/index.js';

type Outcome = 'PASS' | 'FAIL' | 'INFO';

interface StepResult {
  name: string;
  outcome: Outcome;
  detail: string;
}

export interface Smoke {
  env: PayPalEnv;
  paypal: PayPalClient;
  /** Unique per run so idempotency keys / sender_batch_id never collide with an earlier run. */
  deliveryId: string;
  /** Run a required step. A failure is recorded and aborts the script. */
  step<T>(name: string, fn: () => Promise<T>, describe?: (result: T) => string): Promise<T>;
  /** Run an informational probe. Failure is reported but doesn't fail the smoke test. */
  probe<T>(
    name: string,
    fn: () => Promise<T>,
    describe?: (result: T) => string,
  ): Promise<T | undefined>;
  print(label: string, value: unknown): void;
  finish(): never;
}

const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

export function describeError(err: unknown): string {
  if (err instanceof PayPalError) {
    return `${err.status} ${err.issue ?? ''} ${err.message} (debug_id ${err.debugId ?? 'n/a'})`.trim();
  }
  return err instanceof Error ? err.message : String(err);
}

class AbortSmoke extends Error {}

export function createSmoke(name: string): Smoke {
  const env = loadPayPalEnv();
  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'warn',
    transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
  });
  const paypal = createPayPalClient(env, logger);
  const deliveryId = `smoke_${name}_${Date.now()}`;
  const results: StepResult[] = [];

  console.log(C.bold(`\n▶ smoke:${name}`) + C.dim(`  (sandbox, deliveryId ${deliveryId})\n`));

  const finish = (): never => {
    const width = Math.max(...results.map((r) => r.name.length), 10);
    console.log(C.bold('\nSummary'));
    for (const r of results) {
      const tag =
        r.outcome === 'PASS'
          ? C.green('PASS')
          : r.outcome === 'FAIL'
            ? C.red('FAIL')
            : C.yellow('INFO');
      console.log(`  ${tag}  ${r.name.padEnd(width)}  ${C.dim(r.detail)}`);
    }
    const failed = results.some((r) => r.outcome === 'FAIL');
    console.log(
      `\n${failed ? C.red(C.bold(`✖ smoke:${name} FAIL`)) : C.green(C.bold(`✔ smoke:${name} PASS`))}\n`,
    );
    process.exit(failed ? 1 : 0);
  };

  const run = async <T>(
    outcomeOnError: Outcome,
    stepName: string,
    fn: () => Promise<T>,
    describe?: (result: T) => string,
  ): Promise<T | undefined> => {
    process.stdout.write(`  … ${stepName}\r`);
    try {
      const result = await fn();
      const detail = describe ? describe(result) : '';
      results.push({
        name: stepName,
        outcome: outcomeOnError === 'INFO' ? 'INFO' : 'PASS',
        detail,
      });
      console.log(`  ${C.green('✓')} ${stepName}${detail ? C.dim(`  ${detail}`) : ''}`);
      return result;
    } catch (err) {
      if (err instanceof AbortSmoke) throw err;
      const detail = describeError(err);
      results.push({ name: stepName, outcome: outcomeOnError, detail });
      console.log(
        `  ${outcomeOnError === 'INFO' ? C.yellow('•') : C.red('✗')} ${stepName}  ${C.dim(detail)}`,
      );
      if (outcomeOnError === 'FAIL') throw new AbortSmoke();
      return undefined;
    }
  };

  process.on('uncaughtException', (err) => {
    if (!(err instanceof AbortSmoke)) {
      results.push({ name: 'unexpected error', outcome: 'FAIL', detail: describeError(err) });
    }
    finish();
  });
  process.on('unhandledRejection', (err) => {
    if (!(err instanceof AbortSmoke)) {
      results.push({ name: 'unexpected error', outcome: 'FAIL', detail: describeError(err) });
    }
    finish();
  });

  return {
    env,
    paypal,
    deliveryId,
    // Required steps throw on failure, so a resolved value is never undefined.
    step: async <T>(n: string, fn: () => Promise<T>, d?: (r: T) => string) =>
      (await run('FAIL', n, fn, d)) as T,
    probe: (n, fn, d) => run('INFO', n, fn, d),
    print: (label, value) => console.log(`      ${C.dim(label.padEnd(18))} ${String(value)}`),
    finish,
  };
}

export async function pollUntil<T>(
  fn: () => Promise<T>,
  done: (value: T) => boolean,
  opts: { intervalMs: number; timeoutMs: number; onTick?: (value: T) => void },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const value = await fn();
    opts.onTick?.(value);
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

/** Create an AUTHORIZE order, print the approval link, and poll until the sandbox buyer approves it. */
export async function createAndApproveOrder(
  smoke: Smoke,
  amountCents: number,
): Promise<{ orderId: string; authorizationId: string }> {
  const { paypal, deliveryId, env } = smoke;
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, '');

  const order = await smoke.step(
    'create order (intent AUTHORIZE)',
    () =>
      paypal.createOrder({
        deliveryId,
        amount: { cents: amountCents },
        description: `Smoke test ${deliveryId}`,
        returnUrl: `${base}/checkout/return`,
        cancelUrl: `${base}/checkout/cancel`,
        brandName: 'Pay on Delivery (sandbox)',
      }),
    (o) => `order ${o.id} → ${o.status}`,
  );

  const link = approvalUrl(order);
  if (!link) {
    await smoke.step('approval link present', () =>
      Promise.reject(new Error('no payer-action/approve link in order')),
    );
  }
  console.log(
    `\n  ${C.bold('Approve as the sandbox BUYER (personal account):')}\n  ${C.yellow(link ?? '')}\n`,
  );
  console.log(
    C.dim(
      '  Waiting for approval (polling every 3s, up to 10 min). The return page may 404; that is fine.\n',
    ),
  );

  let lastStatus = '';
  await smoke.step(
    'buyer approves order',
    () =>
      pollUntil(
        () => paypal.getOrder(order.id, deliveryId),
        (o) => o.status === 'APPROVED',
        {
          intervalMs: 3000,
          timeoutMs: 10 * 60 * 1000,
          onTick: (o) => {
            if (o.status !== lastStatus) {
              lastStatus = o.status;
              smoke.print('order status', o.status);
            }
          },
        },
      ),
    (o) => `order ${o.id} → ${o.status}`,
  );

  const authorized = await smoke.step(
    'authorize order',
    () => paypal.authorizeOrder({ orderId: order.id, deliveryId }),
    (o) => `order → ${o.status}`,
  );
  const auth = firstAuthorization(authorized);
  const authorization = await smoke.step(
    'authorization created',
    async () => {
      if (!auth) throw new Error('no authorization in authorize response');
      return auth;
    },
    (a) =>
      `auth ${a.id} → ${a.status}, ${a.amount?.value} ${a.amount?.currency_code}, expires ${a.expiration_time ?? 'n/a'}`,
  );
  return { orderId: order.id, authorizationId: authorization.id };
}
