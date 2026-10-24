import { z } from 'zod';
import { PayPalError } from './errors.js';

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

/** Refresh this long before PayPal says the token expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface TokenProviderOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Caches the OAuth access token and refreshes it before expiry.
 * Concurrent callers during a refresh share the same in-flight request.
 */
export class TokenProvider {
  private token: { value: string; refreshAt: number } | null = null;
  private inflight: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: TokenProviderOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async get(): Promise<string> {
    if (this.token && this.now() < this.token.refreshAt) {
      return this.token.value;
    }
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Drop the cached token (e.g. after a 401) so the next call fetches a fresh one. */
  invalidate(): void {
    this.token = null;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(`${this.opts.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const b = body as { error?: string; error_description?: string };
      throw new PayPalError(
        `PayPal OAuth failed: ${b.error_description ?? b.error ?? res.statusText}`,
        res.status,
        b.error,
        res.headers.get('paypal-debug-id') ?? undefined,
      );
    }
    const parsed = tokenResponseSchema.parse(body);
    const lifetimeMs = parsed.expires_in * 1000;
    // Short-lived tokens (unlikely) refresh at half-life instead of going negative.
    const margin = Math.min(REFRESH_MARGIN_MS, lifetimeMs / 2);
    this.token = { value: parsed.access_token, refreshAt: this.now() + lifetimeMs - margin };
    return parsed.access_token;
  }
}
