# Pay on Delivery

A payment layer that replaces cash on delivery. The buyer's payment is **authorized** at checkout and only **captured** after an AI agent verifies proof of delivery (photo, GPS, optional OTP). The rider is paid instantly with PayPal Payouts, and the merchant receives the rest. Ops staff watch everything in an AG Grid dashboard they can query in plain English.

> Built for the PayPal AI Hackathon. **PayPal sandbox only.** All PayPal amounts are USD.

**Status:** week 1. The monorepo, database schema, delivery state machine, PayPal client, webhook endpoint, sandbox smoke scripts and production Docker image are done. The agent, rider app, checkout and ops dashboard are next.

## Repository layout

```
apps/api         Fastify + TypeScript: REST API (/api), PayPal webhooks (/webhooks), BullMQ worker, serves the web app
apps/web         React + Vite: merchant checkout, rider app, ops dashboard (placeholder for now)
packages/shared  Delivery state machine, money helpers, authorization lifecycle, DTO types
```

## Run it locally

Prerequisites: Node 22+, Docker, and Corepack (ships with Node) for pnpm.

```bash
corepack enable                 # pins pnpm to the version in package.json
pnpm install
cp .env.example .env            # then fill in the PayPal sandbox credentials (see below)
docker compose up -d            # Postgres :5432 + Redis :6379
pnpm db:migrate
pnpm dev                        # API on :3000, web on :5173 (proxies /api, /health, /webhooks to the API)
```

Other commands:

```bash
pnpm test          # Vitest (state machine, PayPal client with mocked fetch, paginate helper, webhook route)
pnpm lint          # ESLint (type-aware)
pnpm typecheck
pnpm build         # shared → web → api
pnpm db:generate   # new Drizzle migration after editing apps/api/src/db/schema.ts
```

> Use `127.0.0.1`, not `localhost`, in `DATABASE_URL`/`REDIS_URL`. On Windows with WSL, `localhost` can resolve to `::1` and reach a different service.

### Whole app in Docker (one command)

Runs the production image against the compose Postgres and Redis:

```bash
cp .env.example .env            # fill in PayPal sandbox credentials
docker compose --profile full up --build
# → http://localhost:3000  (web app, /api, /webhooks, /health)
```

The container runs database migrations on startup, then starts the server.

## PayPal sandbox setup

1. Sign in at [developer.paypal.com](https://developer.paypal.com) and open **Sandbox** mode.
2. **Testing Tools → Sandbox Accounts**: you get a default **Business** account (the merchant; it receives captures and funds payouts) and a **Personal** account (the buyer, also usable as the rider's payout receiver). Note the personal account's email and password.
3. **Apps & Credentials → Create App** (type _Merchant_, linked to the sandbox business account). Copy the **Client ID** and **Secret** into `.env`. In the app's features, make sure **Payouts** is enabled.
4. **Webhooks → Add Webhook** on the same app:
   - URL: `https://<your-public-host>/webhooks/paypal`
   - Events: see [the list in CLAUDE.md](CLAUDE.md#webhook-subscriptions): order approved, authorization created/voided, capture completed/pending/declined/refunded/reversed, payouts batch and payouts item events.
   - Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID`.

### Receiving webhooks locally (cloudflared)

PayPal needs a public HTTPS URL. With the API running on :3000:

```bash
cloudflared tunnel --url http://localhost:3000
# prints https://<random>.trycloudflare.com
```

Register `https://<random>.trycloudflare.com/webhooks/paypal` as the webhook URL and set `PUBLIC_BASE_URL` to the same origin. Quick tunnels get a new hostname each run, so for a stable URL use a named tunnel on your own domain (`cloudflared tunnel create`, then `cloudflared tunnel route dns`).

Every webhook is verified with PayPal (`/v1/notifications/verify-webhook-signature`) against the raw request body, stored in `webhook_events`, and de-duplicated by event ID. Events from the dashboard's **webhook simulator** fail verification because they aren't tied to your webhook ID. Use real sandbox flows (the smoke scripts below) to test.

### Sandbox smoke scripts

These prove the risky money flows against the real sandbox. They don't need the database.

```bash
pnpm smoke:authorize-capture   # AUTHORIZE order → approve in browser → authorize → partial capture → push tracking
pnpm smoke:void                # AUTHORIZE order → approve → authorize → void
pnpm smoke:payout              # $1.00 payout to SANDBOX_PAYOUT_RECEIVER_EMAIL, polled to a final status
```

The order scripts print an approval link. Open it, log in as the sandbox **personal** account, and approve. The script polls until the order is approved; the return page may 404, which is fine. Each script ends with a PASS/FAIL summary and exits non-zero on failure.

## Deploying to Dokploy

One container serves everything: the web app, `/api`, `/webhooks`, `/health` and the BullMQ worker, all on the same origin, so no CORS is needed.

1. **Databases:** in your Dokploy project, create a **Postgres** service and a **Redis** service. Copy their _internal_ connection URLs.
2. **Application:** create an Application from this Git repo with **Build Type: Dockerfile** (path `Dockerfile`, context `.`). Container port: **3000**.
3. **Build args** (Dokploy → Application → _Build Args_). These are compiled into the browser bundle, so setting them only as environment variables has **no effect**:

   | Build arg                  | Notes                                            |
   | -------------------------- | ------------------------------------------------ |
   | `VITE_AG_GRID_LICENSE_KEY` | Optional. Without it, AG Grid shows a watermark. |

4. **Environment variables** (runtime only; never baked into the image):

   | Variable                                   | Value                                               |
   | ------------------------------------------ | --------------------------------------------------- |
   | `DATABASE_URL`                             | Dokploy Postgres internal URL                       |
   | `REDIS_URL`                                | Dokploy Redis internal URL                          |
   | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox app credentials                             |
   | `PAYPAL_WEBHOOK_ID`                        | ID of the webhook registered for the production URL |
   | `PAYPAL_ENVIRONMENT`                       | `SANDBOX`                                           |
   | `PUBLIC_BASE_URL`                          | `https://deliver.<your-domain>`                     |
   | `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY`    | Agent model (week 2)                                |

5. **Domain:** in Dokploy add the domain `deliver.<your-domain>` → port 3000, with HTTPS (Let's Encrypt). In Cloudflare, add a proxied (orange-cloud) `A` record for `deliver` pointing at the Dokploy server, and set SSL/TLS mode to **Full (strict)**. The app trusts `X-Forwarded-*` (`trustProxy`), so client IPs and HTTPS are seen correctly behind Cloudflare + Traefik.
6. **PayPal webhook:** register `https://deliver.<your-domain>/webhooks/paypal` on the sandbox app with the event list above, and put its ID in `PAYPAL_WEBHOOK_ID`.

On every start the container runs migrations (idempotent and serialized with a Postgres advisory lock), then starts the server. A failed migration stops the container. `SIGTERM` stops accepting requests, finishes in-flight jobs, and closes the database and Redis connections. The Docker `HEALTHCHECK` calls `GET /health`, which returns 200 when Postgres and Redis respond and 503 otherwise.

## License

[MIT](LICENSE)
