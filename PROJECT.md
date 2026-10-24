# PayPal AI Hackathon — Pay-on-Delivery Agent

**Deadline:** Nov 12, 2026 @ 12:00pm PST
**Target prizes:** Best Use of Agentic Commerce ($5k), AG Grid sponsor prize ($5k / $2k / $1k cash), Grand Prize

## Pitch

In Nigeria and many emerging markets, most e-commerce runs on cash on delivery. Riders carry cash, merchants wait days to get paid, and fake "delivered" claims are common. This product replaces COD with payment that's guaranteed at booking and only released when an AI agent confirms the delivery actually happened.

## Judging criteria (equally weighted)

- Technological implementation
- Design
- Potential impact
- Innovation
- Presentation

Judges may score from the description and video alone, without testing anything, so the 3-minute demo video carries a lot of weight.

## Core money flow

1. Buyer checks out → create PayPal order with `intent: AUTHORIZE` (funds held, not captured)
2. Shipment created → agent attaches tracking to the PayPal order
3. Rider arrives → uploads evidence via mobile web page: photo of package at the door, GPS ping, optional buyer OTP/signature
4. Agent checks evidence against the order:
   - Is the package visible?
   - Is the GPS close to the address?
   - Is the photo fresh and not reused?
   - Does the OTP match?
5. **Pass** → agent captures payment, pays rider fee via Payouts, remainder settles to merchant
6. **Fail / unclear** → agent picks a branch, with a written explanation:
   - request more evidence
   - partial capture (partial delivery)
   - void authorization
   - escalate to a human

> The branching in step 6 is what earns the technical-implementation score. Show at least one rejected delivery in the demo video.

## Stack

- **Backend:** Node.js + TypeScript
- **Agent:** `@paypal/agent-toolkit` with Vercel AI SDK
  - Toolkit covers: create order, capture, refunds, shipment tracking
  - If missing, write custom tools against the REST API for authorize-intent orders and Payouts
- **Data:** Postgres
- **Queues:** BullMQ for time-based work:
  - authorization expiry checks (confirm honor/validity windows in docs; handle reauthorization)
  - "rider hasn't uploaded in X hours" escalations
  - retries
- **AI:** any vision-capable model for proof-of-delivery verification
- **Ops dashboard:** AG Grid (see section below)
- **Hosting:** Dokploy (self-managed Postgres, no expiry), behind a Cloudflare-proxied subdomain (e.g. `deliver.<domain>`)
  - Public HTTPS endpoint for PayPal webhooks
  - `cloudflared` tunnel for local webhook testing
  - Keep it live until judging ends (Dec 15, 2026)

## AG Grid ops dashboard (sponsor prize)

- **AI Toolkit (Enterprise):** natural-language control of the grid
  - e.g. "show rejected deliveries in Lekki today over ₦50k, sorted by confidence"
  - Flow: `getState()` + `getStructuredSchema()` → LLM structured output → `setState()`
- **Master-detail rows:** proof photo, GPS check, agent reasoning, Approve / Void override buttons
- **Live updates:** push row changes when webhooks or agent decisions land
- **Row grouping:** by rider / merchant
- **Integrated charts:** capture rate, rejection reasons
- **MCP server (Community):** use in the editor while building
- [ ] Request a free AG Grid Enterprise trial key from ag-grid.com around Nov 5–8 (covers the demo video; a watermark on the hosted demo after it expires is acceptable)

## Risks to clear in week 1

Confirm in sandbox before building anything else:

- [x] Authorize → capture flow works
- [x] Payouts to a sandbox personal account work (may need enabling on the sandbox business account)
- [x] Webhooks reach the server (via `cloudflared` tunnel)
- [ ] AG Grid Enterprise license situation sorted

## Timeline

| Week | Focus |
|------|-------|
| 1 | Sandbox setup; authorize/capture/payout flow working in plain scripts; delivery state machine; Dokploy + Cloudflare subdomain set up. By Saturday: prove the complete money lifecycle independently of the AI — authorize a sandbox payment, attach shipment/tracking, capture it, successfully trigger a sandbox payout, and receive the relevant webhooks. |
| 2 | Agent loop with tools; vision verification; evidence rules |
| 3 | Rider mobile web page; merchant checkout page; AG Grid ops dashboard (master-detail, live updates, grouping) |
| 4 | AG Grid AI Toolkit natural-language queries + charts; exception branches (partial delivery, reused photo, wrong location); polish |
| 5 | README with judge sandbox credentials; open-source license; demo video |

## Submission checklist

- [ ] Public repo (GitHub) with open-source license visible in the About section
- [ ] README with full setup/run instructions + sandbox test credentials
- [ ] Hosted demo URL (Dokploy, live through Dec 15)
- [ ] Demo video < 3 min, public on YouTube
  - Split screen: rider's phone + AG Grid ops dashboard, so money moving is visible
  - Show one successful delivery and one rejected delivery
  - Show a natural-language query driving the grid
- [ ] Text description: problem, who it's for, why it matters
- [ ] Mention AG Grid usage clearly in the description (for sponsor prize eligibility)
- [ ] No copyrighted music or third-party trademarks in the video

## Webinar to attend

- Oct 13, 1am PT (9am Lagos) — "Start building with PayPal"