# CLAUDE.md — Pay-on-Delivery Agent

Hackathon project for the **PayPal AI Hackathon** (Devpost). Submission deadline: **Nov 12, 2026 @ 12:00pm PST**. Judging runs Dec 1–15, 2026; the hosted demo must stay live until then.

## What we're building

A payment layer that replaces cash on delivery. Payment is **authorized** at checkout and only **captured** after an AI agent verifies proof of delivery. The rider gets paid instantly via PayPal Payouts; the merchant receives the rest. Ops staff monitor everything in an AG Grid dashboard they can query in natural language.

Three surfaces:
1. **Merchant checkout** — buyer pays (authorize, not capture)
2. **Rider web app** (mobile-first) — uploads proof of delivery: photo, GPS, optional buyer OTP
3. **Ops dashboard** — AG Grid with live deliveries, agent reasoning, manual overrides, natural-language queries

## Hard constraints

- **PayPal sandbox only.** Never point at live endpoints. Base URL: `https://api-m.sandbox.paypal.com`.
- **Currency:** PayPal does not support NGN. All PayPal amounts are in **USD**. NGN may be shown in the UI as a display-only conversion; never send NGN to PayPal.
- **Money is never a float.** Store amounts as integer minor units (cents) in the DB; send PayPal decimal strings (`"12.50"`).
- **Repo must be public and open source** (MIT license file at root) with full setup instructions in README.
- **Judges must be able to run it.** Keep setup simple: `docker compose up` + a seed script + documented sandbox credentials.

## Stack

- **Monorepo:** pnpm workspaces
  - `apps/api` — Node.js + TypeScript, Fastify
  - `apps/web` — React + Vite + TypeScript (merchant checkout, rider app, ops dashboard as routes)
  - `packages/shared` — zod schemas, types, delivery state machine
- **DB:** Postgres, Drizzle ORM + migrations
- **Queues:** Redis + BullMQ (worker can run in the API process for the demo)
- **Agent:** Vercel AI SDK + `@paypal/agent-toolkit` (`@paypal/agent-toolkit/ai-sdk`), plus custom tools where the toolkit lacks coverage
- **AI model:** vision-capable model, provider configured via env (`AI_PROVIDER`, `AI_MODEL`)
- **Grid:** AG Grid React (Enterprise for AI Toolkit, master-detail, row grouping, integrated charts)
- **Hosting:** Dokploy, behind a Cloudflare-proxied subdomain. `cloudflared` tunnel for local webhook testing.
- **API response shaping:** `@kn0mic/reshaper` (Laravel-style API Resources for Node; the author's own package)
- **Tests:** Vitest

## Delivery state machine

Lives in `packages/shared`. All transitions go through it; never update `delivery.status` directly.

```
CREATED → AUTHORIZED → IN_TRANSIT → EVIDENCE_SUBMITTED → VERIFYING
VERIFYING → CAPTURED → PAYOUT_PENDING → RIDER_PAID → SETTLED
VERIFYING → PARTIALLY_CAPTURED → PAYOUT_PENDING
VERIFYING → NEEDS_MORE_EVIDENCE → EVIDENCE_SUBMITTED
VERIFYING → ESCALATED → (human) CAPTURED | VOIDED
AUTHORIZED | IN_TRANSIT | ESCALATED → VOIDED
CAPTURED | PARTIALLY_CAPTURED | PAYOUT_PENDING | RIDER_PAID → (human) REFUNDED
CREATED | AUTHORIZED | IN_TRANSIT | EVIDENCE_SUBMITTED | VERIFYING
  | NEEDS_MORE_EVIDENCE | ESCALATED → EXPIRED   (order abandoned / authorization lapsed)
```

Terminal states: `SETTLED`, `VOIDED`, `EXPIRED`, `REFUNDED`.

- `EXPIRED` only applies before capture. Once funds are captured the authorization window no longer matters.
- `REFUNDED` is the human override after capture. A captured payment is refunded, never voided.
- `PAYOUT_PENDING` is set when the payout batch is created. `RIDER_PAID` is set **only** from the payout item webhook (`PAYMENT.PAYOUTS-ITEM.SUCCEEDED`) or the payout polling fallback job, never from the create-payout response.
- Reauthorization does not change state. It swaps the delivery's current authorization ID.

## Delivery flow (money + tracking)

1. Checkout: create order (`intent: AUTHORIZE`, **PayPal wallet only** via `payment_source.paypal`; no card fields, because reauthorization only works for PayPal-account payments) → buyer approves → authorize → `AUTHORIZED`.
2. Shipment created: tracking (carrier + tracking number) is stored in **our DB** (`shipments`) → `IN_TRANSIT`. Nothing goes to PayPal yet.
3. Rider evidence → agent → policy → capture (full or partial) → `CAPTURED` / `PARTIALLY_CAPTURED`.
4. After capture: push the stored tracking to PayPal via `/v2/checkout/orders/{id}/track` with `capture_id` (the ID from the **authorization-capture** response). PayPal requires `capture_id`, so tracking can't be added before capture.
5. Create rider payout → `PAYOUT_PENDING` → payout webhook (or polling fallback) → `RIDER_PAID` → `SETTLED`.

## PayPal integration rules

Key endpoints (v2 unless noted):
- Create order (`intent: AUTHORIZE`): `POST /v2/checkout/orders`
- Authorize approved order: `POST /v2/checkout/orders/{id}/authorize`
- Capture authorization (full or partial): `POST /v2/payments/authorizations/{id}/capture`
- Void: `POST /v2/payments/authorizations/{id}/void`
- Reauthorize: `POST /v2/payments/authorizations/{id}/reauthorize`
- Add tracking: `POST /v2/checkout/orders/{id}/track`
- Payouts: `POST /v1/payments/payouts`
- Verify webhook: `POST /v1/notifications/verify-webhook-signature`

Rules:
- Every money-moving POST sends a `PayPal-Request-Id` idempotency key derived from `deliveryId + action` (e.g. `dlv_123:capture`). Retries must reuse the same key. Actions that can legitimately repeat include an attempt number (`dlv_123:reauthorize:1`). Payouts also set `sender_batch_id` to the same key.
- **Verify every webhook signature** before processing. Process webhooks idempotently (store event IDs; skip duplicates). Verify against the **raw** request body; never re-serialize the parsed JSON.
- Treat webhooks as the source of truth for final payment state; API responses update state optimistically.
- Access tokens are cached and refreshed before expiry; never fetch a new token per request.
- **Captures always send `final_capture: true`**, including partial captures. The uncaptured remainder is released by PayPal, so no void is needed after a partial capture. (PayPal's default is `false`.)
- You **cannot void** a fully captured authorization. Post-capture reversals are refunds (`POST /v2/payments/captures/{id}/refund`).

### Authorization lifecycle (verified in PayPal docs, Oct 2026)

- An authorization is valid for **29 days** with a **3-day honor period**.
- Reauthorization is allowed after the honor period, within the 29 days, and can be repeated. Each one returns a **new authorization ID** and starts a fresh 3-day honor period. The 29-day validity still counts from the original authorization.
- In the US, a reauthorization can be up to 115% of the original amount, capped at +$75. After 30 days you must create a new order.
- Reauthorization only works for **PayPal-account** payments, which is why checkout is wallet-only.

A BullMQ job per delivery, scheduled from the **original** `authorizedAt` (constants in `packages/shared`):

| When | Offset | Action (only if still undelivered, i.e. not yet captured) |
|------|--------|------------------------------------------------------------|
| Day 3 | +48h | Flag on dashboard: honor period ending |
| Day 4 | +72h | Reauthorize; store the new auth ID as the delivery's current authorization (old row kept in `payments`) |
| Day 29 | +28d | Void the current authorization → `EXPIRED` |

### Webhook subscriptions

`CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, `PAYMENT.PAYOUTSBATCH.PROCESSING`, `PAYMENT.PAYOUTSBATCH.SUCCESS`, `PAYMENT.PAYOUTSBATCH.DENIED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `PAYMENT.PAYOUTS-ITEM.FAILED`, `PAYMENT.PAYOUTS-ITEM.BLOCKED`, `PAYMENT.PAYOUTS-ITEM.CANCELED`, `PAYMENT.PAYOUTS-ITEM.HELD`, `PAYMENT.PAYOUTS-ITEM.REFUNDED`, `PAYMENT.PAYOUTS-ITEM.RETURNED`, `PAYMENT.PAYOUTS-ITEM.UNCLAIMED`.

Payouts are asynchronous: a batch can return `PENDING`/`PROCESSING`. A polling fallback job (`GET /v1/payments/payouts/{batch_id}`) covers missed webhooks.

## Agent design

The agent **decides**; code **enforces**. The LLM never moves money directly.

1. Agent receives order details + evidence (photo, GPS, OTP result, photo hash, timestamps).
2. Deterministic checks run first in code: GPS distance to address, OTP match, photo reuse (perceptual hash against prior uploads), EXIF/upload timestamp freshness.
3. Vision model assesses the photo (package visible? doorstep/location plausible?).
4. Agent returns a **zod-validated structured decision**: `{ action, confidence, captureAmount?, reasoning, evidenceSummary }` where `action ∈ capture | partial_capture | request_evidence | void | escalate`.
5. **Policy layer** (plain TypeScript, unit-tested) validates the decision before any PayPal call:
   - capture amount ≤ authorized amount
   - transition is legal in the state machine
   - confidence below threshold → force `escalate`
   - deterministic check failures can't be overridden by the model
6. Decision + reasoning are persisted to `agent_decisions` **before** the PayPal call (audit trail shown in the dashboard).
7. After a successful capture, code (not the LLM) pushes the stored tracking to PayPal with the `capture_id`, then creates the rider payout (`PAYOUT_PENDING`). Captures always use `final_capture: true`.

Agent tools (PayPal toolkit where available; custom otherwise): capture authorization, void authorization, request more evidence (notifies rider), escalate. Order creation, tracking push, payouts, reauthorization and refunds are code paths or human actions, not agent decisions.

Human overrides (dashboard): an escalated delivery can be approved (capture) or voided. A captured delivery can be **refunded** (`REFUNDED`), never voided.

## AG Grid dashboard (sponsor prize — make it shine)

- **AI Toolkit:** natural-language queries → `gridApi.getState()` + `gridApi.getStructuredSchema()` → LLM structured output → `gridApi.setState()`. Send the current state and pass `propertiesToIgnore` so unchanged state isn't overwritten.
- **Master-detail:** expanded row shows proof photo, GPS map/distance, deterministic check results, agent reasoning, Approve/Void buttons for escalations, Refund for captured deliveries, a "honor period ending" flag (day 3).
- **Live updates:** server pushes row changes (SSE) on webhook/agent events; apply via `applyTransactionAsync`.
- **Row grouping** by rider/merchant; **integrated charts** for capture rate and rejection reasons.
- License key via `VITE_AG_GRID_LICENSE_KEY`; the app must still run without it (watermark is acceptable in dev).

## Environment variables

```
DATABASE_URL=
REDIS_URL=
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_WEBHOOK_ID=
PAYPAL_ENVIRONMENT=SANDBOX
AI_PROVIDER=
AI_MODEL=
AI_API_KEY=
PUBLIC_BASE_URL=
API_PORT=3000
VITE_AG_GRID_LICENSE_KEY=
SANDBOX_PAYOUT_RECEIVER_EMAIL=   # smoke-payout only: a sandbox personal account email
```

Keep `.env.example` in sync whenever a variable is added. Never commit real secrets.

## Commands

```
corepack enable             # pnpm version pinned via package.json "packageManager"
pnpm install
docker compose up -d        # postgres :5432 + redis :6379
pnpm db:migrate
pnpm db:seed                # TODO: demo merchants, riders, deliveries (not written yet)
pnpm dev                    # api :3000 (tsx watch) + web :5173 (Vite, proxies /api /health /webhooks)
pnpm test                   # vitest (shared + api projects)
pnpm lint                   # type-aware eslint
pnpm typecheck
pnpm db:generate            # new migration after editing apps/api/src/db/schema.ts
pnpm smoke:authorize-capture | smoke:void | smoke:payout   # sandbox smoke scripts (no DB needed)
docker compose --profile full up --build                  # whole app from the production Dockerfile
```

Workspace notes:
- `injectWorkspacePackages: true` (needed by `pnpm deploy` in the Dockerfile). In dev, `@pod/shared` resolves to its **source** via tsconfig `paths` (tsx/tsc) and aliases in `vite.config.ts` / `vitest.config.ts`; the injected copy is only used by builds and the image.
- Use `127.0.0.1` rather than `localhost` in local URLs (WSL can own `::1:5432`).
- Routes: REST under `/api`, PayPal webhooks under `/webhooks`, `GET /health`; Fastify serves the built web app (SPA fallback) in production.

## Conventions

- TypeScript `strict: true` everywhere. No `any` without a comment explaining why.
- Validate all external input (HTTP bodies, webhooks, LLM output) with zod at the boundary.
- PayPal client lives in one module (`apps/api/src/paypal/`); nothing else calls PayPal directly.
- Policy layer and state machine have unit tests; PayPal calls are mocked in unit tests and exercised against sandbox in a separate integration script.
- Log every state transition and PayPal call with `deliveryId` for traceability.
- Small, focused commits. Don't refactor unrelated code while working on a feature.

## API responses with Reshaper

Every JSON response from `apps/api` goes through a `@kn0mic/reshaper` resource. Route handlers never return raw DB rows.

- One resource class per entity in `apps/api/src/resources/` (e.g. `DeliveryResource`, `AgentDecisionResource`, `RiderResource`, `MerchantResource`, `PayoutResource`), each extending `Resource` with a typed `static transform(entity, options)`.
- Single items: `XResource.wrap(XResource.transform(entity))` → `{ data: {...} }`
- Lists: `XResource.collection(rows)` inside `wrap`, or `XResource.paginate(result, { page, perPage })` for paginated endpoints. Reshaper's paginate examples use Objection.js page results; check the package's types/source for the expected input shape and adapt Drizzle query results to it in one helper, not per route.
- Use `Resource.clean` with `when` / `whenLoaded` / `whenNotNull` for conditional and relation fields instead of ad-hoc `if` blocks.
- Never expose internal fields: PayPal access tokens, raw webhook payloads, idempotency keys, or rider personal data beyond what the view needs. Ops-only fields (full agent reasoning, raw check results) use `Resource.when(options.isOps, ...)`.
- Money fields: transform cents to a decimal string (`"12.50"`) plus a `currency` field in the resource, so the frontend never does money math on floats.
- Resource output types are exported from `packages/shared` so the frontend consumes the same DTO types.

## Demo priorities

The judges may only watch the 3-minute video. Optimize for:
1. One successful delivery end-to-end: checkout → rider upload → agent approves → capture + payout visible in dashboard.
2. One rejected delivery (reused photo or wrong GPS) → agent escalates with clear reasoning → human override.
3. A natural-language query driving the AG Grid.

A seed script must be able to put the app into a demo-ready state in one command.

## Week-1 risks to confirm in sandbox first

- [x] Authorize → capture works (partial verified Oct 24; full capture not yet exercised)
- [x] Payouts to a sandbox personal account work (Oct 24)
- [x] Webhooks reach the server through the tunnel and verify correctly (Oct 24)
- [x] Agent toolkit coverage (Oct 24, v1.11.0): no authorization capture/void/reauthorize, no payouts, `create_order` is CAPTURE-only. Tools use the AI SDK v4 shape (`parameters`, zod 3), so they need an adapter for current `ai`. All agent tools are custom.