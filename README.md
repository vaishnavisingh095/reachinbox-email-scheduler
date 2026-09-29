# ReachInbox Email Scheduler

A restart-safe, rate-limited email campaign scheduler: schedule a campaign
to a list of recipients, and a BullMQ-backed worker delivers each email at
its scheduled time — subject to a per-sender minimum delay and dual
(sender-wide + per-campaign) hourly rate limits — while remaining
restart-safe through persisted application state and BullMQ-backed
scheduling. See
[`docs/architecture.md`](./docs/architecture.md) for how the system works,
[`docs/decision.md`](./docs/decision.md) for why it's built this way (ADR
log), and [`docs/plan.md`](./docs/plan.md) for the build sequence.

## Features

- Campaign scheduling via BullMQ delayed jobs (no cron) — start time,
  per-email delay, and hourly limit are set per campaign.
- Restart-safe: boot-time reconciliation re-enqueues any `scheduled` row
  missing a live job, and recovers or flags rows stuck mid-send.
- Per-sender minimum send delay (Redis lock) and dual hourly rate limits
  (sender-wide + per-campaign), enforced atomically in one Lua script.
- Idempotent campaign creation via an `Idempotency-Key` header, backed by a
  Postgres unique constraint (not Redis).
- Google OAuth login with signed session cookies; ownership isolation so a
  user only ever sees their own senders/campaigns/emails.
- Slack OAuth connection with rate-limit notifications, fully optional and
  a no-op when disconnected.
- Elasticsearch-backed search over sent/failed emails, scoped to the
  authenticated user, with a backfill script.
- Bull Board queue dashboard, gated by session + an admin email allow-list.
- A Next.js dashboard: login, scheduled/sent email tables, campaign
  compose (CSV or pasted recipients), Slack connect card, and search.

## Architecture

npm-workspaces monorepo: `backend/` (Express API + BullMQ worker, run as
two separate processes) and `frontend/` (Next.js dashboard), sharing one
root `package.json` for orchestration.

- **PostgreSQL** — source of truth for users, senders, campaigns, emails,
  rate-window audit rows, Slack connections, and idempotency keys.
- **Redis** — BullMQ's job store, plus two live enforcement mechanisms:
  per-sender minimum-delay locks and the dual rate-limit counters (both
  read/written via Lua scripts for atomicity). AOF-enabled in Docker so
  queued jobs survive a container restart.
- **BullMQ** — one delayed job per recipient email; `delay` is computed
  from the campaign's `startAt` and per-recipient offset.
- **Elasticsearch** — a derived, best-effort search index over sent/failed
  emails (ADR-010). Postgres remains authoritative; an ES outage never
  affects scheduling or delivery, only search.
- **Express API** — auth, campaigns, senders, emails, search, and the Bull
  Board mount, all behind session auth and CORS restricted to
  `FRONTEND_URL`.
- **Bull Board** — a read-only view over the same queue the worker
  consumes, mounted at `/admin/queues`.
- **Next.js frontend** — a separate origin from the API; talks to it via
  `credentials: "include"` fetches, never local token storage.

## Scheduling & Delivery

`POST /campaigns` resolves a sender, subject, body, and recipient list
into one `campaign` row and one `email` row per recipient (each row's
`scheduledAt` is `startAt + position * delayBetweenEmailsMs`), commits them
in a single transaction, then calls BullMQ's `addBulk` with each job's
`delay` computed from `scheduledAt`. The worker (`npm run dev:worker`, a
separate process from the API) consumes jobs at their scheduled time and
runs `processEmail`: claim the row, acquire the sender's delay lock, pass
the dual rate-limit check, then send via Ethereal SMTP. If the lock or the
rate limit isn't granted, the job is rescheduled (not failed) — sender-lock
misses retry after `MIN_DELAY_MS` plus a small jitter; rate-limit misses
retry at the start of the next hour plus jitter.

## Persistence & Restart Safety

Rows are committed to Postgres (campaign + emails, and the idempotency
claim if any) *before* jobs are enqueued — if `addBulk` fails partway, the
affected rows are left `scheduled` with no job, and boot-time
reconciliation (`reconcile()`, run once when the worker process starts)
re-enqueues any `scheduled` row that has no live BullMQ job, keyed off
Postgres rather than Redis's view, so this is correct even after a full
Redis wipe.

For rows stuck in `processing` past a 10-minute threshold (a worker died
mid-send), reconciliation checks whether `message_id` was already written:
if not, the send never completed and the row is safely moved back to
`scheduled`. If `message_id` *is* present but `status` never reached
`sent`, the send may have completed before the crash — reconciliation
logs this as ambiguous and does **not** auto-resend, since doing so risks
a real duplicate. This window is real and intentionally reachable: the
worker writes `message_id` and `status = 'sent'` as two separate,
sequential Postgres statements rather than one combined update
(ADR-017), specifically so a crash between them is a narrow, honestly
observable state instead of collapsed into "safe to retry" by Postgres's
own statement-level atomicity.

## Rate Limiting & Concurrency

Two independent controls, both enforced in Redis (the live authority) and
separately audited in Postgres (`rate_windows`, downstream-only, never
gating):

- **Per-sender minimum delay** — `SET lock:sender:{senderId} 1 NX PX
  {MIN_DELAY_MS}` before every send attempt; visible across every worker
  process and concurrent job slot, not just one in-process timer.
- **Hourly rate limits** — a single Lua script (`dualRateLimit`, via
  `ioredis.defineCommand`) atomically checks and increments *both* a
  sender-wide counter (`rate:{senderId}:{hourWindow}`, env-configured via
  `MAX_EMAILS_PER_HOUR_PER_SENDER`, not overridable per campaign) and a
  per-campaign counter (`rate:campaign:{campaignId}:{hourWindow}`,
  settable per campaign, defaulting to the same env value) in one atomic
  step — a slot is granted only if both are under their limit, and
  neither counter is touched on a refused attempt.

Worker concurrency is controlled by `WORKER_CONCURRENCY` (BullMQ's
`Worker` concurrency option) — how many jobs one worker process pulls at
once; the sender lock and rate limits above are what keep sends
correctly spaced regardless of that concurrency. When a rate-limit
attempt is refused, the worker also sends a best-effort Slack
notification (deduplicated per sender + hour window, a complete no-op if
Slack isn't connected).

Idempotent campaign creation (`Idempotency-Key` header) is enforced by
Postgres, not Redis: the `idempotency_keys(user_id, key)` unique
constraint's insert happens *inside* the same transaction as the
campaign+email creation, so Postgres's own row-lock serializes two
concurrent identical requests — the loser's transaction fails on that
unique constraint and is handled by replaying the winner's stored
response, rather than creating a second campaign.

## Authentication & Security

Login is Google OAuth (authorization-code flow): `GET /auth/google`
redirects to Google with a random state in a short-lived httpOnly cookie;
`GET /auth/google/callback` rejects any request whose `state` doesn't
match that cookie (CSRF protection), exchanges the code, upserts the user,
and sets a signed JWT session cookie. `GET /auth/me` reflects the current
session; `POST /auth/logout` clears the cookie (there's no server-side
session record to invalidate — the cookie itself is the credential).

Every resource (senders, campaigns, emails) is scoped to
`req.userId`; a resource that exists but belongs to another user returns
404, identical to one that doesn't exist. `/admin/queues` (Bull Board) is
gated by both a valid session *and* the session's email being in the
comma-separated `ADMIN_EMAILS` allow-list.

All production routes resolve their auth middleware through a single
swap point, `requireAuth` in `backend/src/middleware/authMode.ts`, which
currently points at the real session-cookie check
(`sessionAuth.ts`). An earlier development-only header-based shim
(`devAuth.ts`, `X-Dev-User-Id`) still exists in the codebase for local/
manual testing but is not wired into `requireAuth` and is not reachable
by any production route.

## Slack Notifications

Optional, per-user: `GET /auth/slack/install` (requires an existing
session) redirects to Slack's OAuth authorize URL with the
`incoming-webhook` scope and a signed JWT `state` encoding the user id
(reused `SESSION_SECRET`, a distinct payload shape from the session
cookie). `GET /auth/slack/callback` verifies that state (not a fresh
session check — the state itself proves which user started the flow),
exchanges the code, and upserts a `SlackConnection` (webhook URL, or bot
token + channel id). `GET /auth/slack/status` reports connection state and
team name; `DELETE /auth/slack` disconnects.

When a sender's hourly limit is hit, the worker posts a rate-limit
notification to the connected webhook/channel — deduplicated per
`(sender, hour window)`. If nothing is connected, notification is a
complete no-op: it never affects the reschedule outcome either way.

## Search

`GET /emails/search?q=...` queries Elasticsearch, scoped to the
authenticated user's own emails; an empty/missing `q` is rejected with
400. Only successful/failed sends are indexed, on the hot path, as a
best-effort side effect of `processEmail` (indexing errors are swallowed
and never affect delivery). If the index falls behind (e.g. after an ES
outage), re-index everything from Postgres:

```bash
cd backend && npx tsx scripts/backfill-elasticsearch.ts
```

An Elasticsearch outage surfaces as a clean `503 SEARCH_UNAVAILABLE` from
the search endpoint (ADR-010) — it never touches or blocks the
scheduling/delivery path.

## Backend Setup

Prerequisites: Node.js 20+, npm, Docker (with Compose).

```bash
cp .env.example .env
npm install                # installs both workspaces (backend/, frontend/)
docker compose up -d       # postgres, redis, elasticsearch
docker compose ps          # wait until all three are "healthy"
npm run db:migrate         # applies Prisma migrations
npm run db:seed            # 2 dev users, 3 senders, 4 campaigns, 8 emails
npm run dev:backend        # API on :4000
npm run dev:worker         # BullMQ worker — separate process, run alongside the API
```

> **Port note:** Postgres is exposed on host port **5433**, not 5432, to
> avoid colliding with a native Postgres already bound to
> `127.0.0.1:5432` (common with Postgres.app / Homebrew).
> `.env.example` already points `DATABASE_URL` at `5433`.

Seeded senders use placeholder Ethereal credentials (`@ethereal.invalid`)
— see [Ethereal Email Setup](#ethereal-email-setup) below for real sends.

```bash
curl http://localhost:4000/health
```

returns `200` once the API can reach Postgres and Redis (Elasticsearch is
intentionally not checked here — ADR-010). If a required environment
variable is missing, the process fails immediately on boot with a list of
what's missing.

Other backend scripts (from the repo root): `npm run build:backend`,
`npm run typecheck:backend`, `npm run db:studio` (Prisma Studio),
`npm run db:generate`.

**Google OAuth:**
1. Create an OAuth 2.0 Client ID (Web application) at
   [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Add an authorized redirect URI: `{API_URL}/auth/google/callback`
   (`http://localhost:4000/auth/google/callback` for local dev).
3. Put the client id/secret in `.env` as `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET`.
4. Visit `http://localhost:4000/auth/google` to sign in.

Without real credentials, the OAuth code path still runs end-to-end up to
Google's own consent screen (redirect URL, state/CSRF handling, and
token-exchange error handling are all real and testable) — only the
actual Google login needs a registered app.

**Slack OAuth:**
1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
   with the `incoming-webhook` OAuth scope.
2. Add a redirect URL: `{API_URL}/auth/slack/callback`.
3. Put the client id/secret in `.env` as `SLACK_CLIENT_ID` /
   `SLACK_CLIENT_SECRET`.
4. With a session cookie set (via Google login above), visit
   `http://localhost:4000/auth/slack/install` to connect.

## Frontend Setup

```bash
cp frontend/.env.example frontend/.env.local
npm run dev:frontend
```

Loads at `http://localhost:3000`. `frontend/.env.local` sets
`NEXT_PUBLIC_API_URL` (default `http://localhost:4000`) — the frontend
and API are separate origins; the API's session cookie lives on the
API's own origin and is sent automatically on credentialed cross-origin
requests (`credentials: "include"` in `frontend/src/lib/api.ts`), gated
by CORS on the API side (restricted to `FRONTEND_URL`, in
`backend/src/app.ts`).

Flow: `/login` → "Continue with Google" navigates the browser to the
API's `GET /auth/google` (a real top-level redirect, not a fetch) →
Google → the API's callback sets the session cookie and redirects back
to `/dashboard`. Since the API and Google OAuth redirect URI are both
`http://localhost:4000` by default, no extra frontend-side redirect
configuration is needed beyond `NEXT_PUBLIC_API_URL` pointing at the
right API origin. Logout calls `POST /auth/logout` on the API.

Other frontend scripts: `npm run build:frontend`,
`npm run typecheck:frontend`, `npm run lint --workspace frontend`.

## Ethereal Email Setup

Email delivery uses [Ethereal](https://ethereal.email/) (nodemailer's
fake-SMTP testing service), not a real mail provider — this project does
**not** claim real production email delivery. Seeded senders ship with
placeholder `@ethereal.invalid` credentials that will not send.

To send for real (into Ethereal's own inbox, not an external mailbox):
create a free Ethereal test account via `nodemailer.createTestAccount()`
(instant, no signup) and write its `user`/`pass` onto a `senders` row's
`email` / `ethereal_pass` columns (ADR-011: one Ethereal identity per
sender, created once and persisted — not created automatically). Each
sent email's Ethereal preview URL is stored on the `emails` row
(`previewUrl`) and surfaced in the dashboard/API so a reviewer can open
the actual rendered message.

## Environment Variables

Backend (repo-root `.env`, copied from `.env.example`; validated at boot
by `backend/src/config/env.ts` — the process refuses to start if any of
these is missing):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (matches `docker-compose.yml`, port 5433) |
| `REDIS_URL` | Redis connection string |
| `ELASTICSEARCH_URL` | Elasticsearch connection string |
| `WORKER_CONCURRENCY` | BullMQ worker's concurrent job count |
| `MIN_DELAY_MS` | Per-sender minimum delay between sends |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | Sender-wide hourly send limit |
| `GOOGLE_CLIENT_ID` | Google OAuth client id |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret — placeholder: `YOUR_GOOGLE_CLIENT_SECRET` |
| `SLACK_CLIENT_ID` | Slack OAuth client id |
| `SLACK_CLIENT_SECRET` | Slack OAuth client secret — placeholder: `YOUR_SLACK_CLIENT_SECRET` |
| `SESSION_SECRET` | Signs the session cookie; must be a long random string, not the `.env.example` placeholder — placeholder: `YOUR_LONG_RANDOM_SESSION_SECRET` |
| `ADMIN_EMAILS` | Comma-separated allow-list for `/admin/queues` |
| `FRONTEND_URL` | Frontend origin, used for CORS and OAuth redirects |
| `API_URL` | This API's own origin, used to build OAuth redirect URIs |
| `NODE_ENV` | `development` \| `production` \| `test` (defaults to `development`) |

A real Ethereal account's password (if you create one per
[Ethereal Email Setup](#ethereal-email-setup)) is stored on a `senders`
row in Postgres, not in `.env` — placeholder if documenting one
elsewhere: `YOUR_ETHEREAL_PASSWORD`.

Frontend (`frontend/.env.local`, copied from `frontend/.env.example`):

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_API_URL` | Base URL of the backend API (default `http://localhost:4000`) |

**`.env` and `.env.local` files must never be committed** — both are
git-ignored; only their `.env.example` templates (which contain no real
secrets) are tracked.

## API Overview

All routes below are mounted in `backend/src/app.ts`. Routes marked
"auth" require a valid session cookie; ownership-scoped routes never
expose another user's rows (404 instead of 403).

**Health**
| Method & Path | Description |
|---|---|
| `GET /health` | 200 if Postgres and Redis are reachable, else 503 |

**Auth**
| Method & Path | Description |
|---|---|
| `GET /auth/google` | Start Google OAuth (sets CSRF state cookie, redirects) |
| `GET /auth/google/callback` | Google OAuth callback — sets session cookie |
| `GET /auth/me` | Current session user (auth) |
| `POST /auth/logout` | Clear the session cookie |

**Slack**
| Method & Path | Description |
|---|---|
| `GET /auth/slack/install` | Start Slack OAuth (auth) |
| `GET /auth/slack/callback` | Slack OAuth callback — verified via signed state |
| `GET /auth/slack/status` | Connection status + team name (auth) |
| `DELETE /auth/slack` | Disconnect Slack (auth) |

**Campaigns**
| Method & Path | Description |
|---|---|
| `POST /campaigns` | Create a campaign + its emails (auth; supports `Idempotency-Key` header) |
| `GET /campaigns` | List the caller's campaigns, paginated (auth) |
| `GET /campaigns/:id` | One campaign with per-status email counts (auth, ownership-scoped) |

**Senders**
| Method & Path | Description |
|---|---|
| `GET /senders` | List the caller's senders with current-hour usage (auth) |

**Emails / Search**
| Method & Path | Description |
|---|---|
| `GET /emails?status=scheduled\|sent` | Scheduled or sent/failed emails, paginated (auth) |
| `GET /emails/search?q=...` | Elasticsearch search over the caller's own emails (auth) |

**Admin**
| Method & Path | Description |
|---|---|
| `GET /admin/queues` | Bull Board dashboard (auth + `ADMIN_EMAILS` allow-list) |

## Project Structure

```
backend/
  src/
    admin/        Bull Board mounting
    auth/         Google OAuth exchange, session cookie signing
    campaigns/    Campaign creation (idempotency, transaction, addBulk)
    config/       Zod-validated environment schema
    lib/          Prisma/Redis clients, Slack API calls, HTTP error helper
    mail/         Ethereal SMTP sending
    middleware/   Auth swap point, session auth, admin gate, dev-only shim
    queue/        BullMQ queue, sender lock, dual rate limiter, Slack notify
    routes/       Express routers (auth, slack, campaigns, senders, emails, health)
    search/       Elasticsearch client and indexing/search
    worker/       Job claiming, per-email processing, boot-time reconciliation
    app.ts        Express app assembly (middleware, routes, error handler)
    server.ts     API process entrypoint
    worker.ts     Worker process entrypoint
  prisma/         Schema, migrations, seed script
  scripts/        Elasticsearch backfill, idempotency concurrency test, manual test-email script
frontend/
  src/
    app/          Next.js App Router pages (login, dashboard)
    components/
      features/   Compose modal, email table, sidebar, search results, etc.
      ui/          Shared primitives (button, modal, input, toast, ...)
    hooks/        Data-fetching hooks (campaigns, emails, senders, Slack status)
    lib/           API client, auth context, recipient parsing
    types/        Shared API response types
docs/
  architecture.md How the system works
  decision.md     ADR log — why it's built this way
  plan.md         Build sequence
docker-compose.yml   Postgres, Redis, Elasticsearch
```

## Verified / Tested

The following were manually exercised against the local Docker
infrastructure during development (no automated test suite exists):

- `npm run db:migrate` + `npm run db:seed` apply cleanly; `GET /health`
  returns 200 once Postgres and Redis are up.
- `POST /campaigns` with a real recipient list creates the campaign +
  email rows and visibly enqueues delayed jobs, viewable in Bull Board
  at `/admin/queues`.
- A 1,005-recipient CSV campaign was exercised successfully: the UI
  accepted all 1,005 recipients, the campaign was queued, and Bull Board
  showed the resulting delayed jobs.
- Concurrent identical `POST /campaigns` requests with the same
  `Idempotency-Key` were run against each other repeatedly via
  `backend/scripts/test-concurrent-idempotency.ts`: exactly one campaign
  is created, and the losing request replays the winner's stored
  response instead of creating a duplicate.
- The ADR-017 ambiguous-delivery window was reproduced live: a real
  Ethereal send, a partial write (`message_id` only), a backdated
  `updatedAt`, and a real worker restart — `reconcile()` correctly
  logged it as ambiguous and did not auto-resend.
- The dual rate limiter was exercised by lowering the limits and sending
  a batch past them: jobs past the limit are rescheduled (not failed),
  and the Slack notification fires exactly once per `(sender, hour
  window)` when connected.
- CORS was verified with a real cross-origin credentialed request from
  the frontend's origin, and rejected from an arbitrary other origin.
- Killing Postgres mid-request produces a clean fast `500`
  (`express-async-errors` + the global error handler), not a hang.
- The Google OAuth flow was exercised end-to-end up to Google's consent
  screen (state/CSRF cookie set and checked, token-exchange error
  handling), using a real registered OAuth client.
- The Slack OAuth flow was exercised end-to-end with a real Slack app:
  connect, a rate-limit notification delivered to the channel,
  disconnect, and reconnect.
- `GET /emails/search` was verified against the Elasticsearch container
  for both matching and non-matching queries, and
  `backfill-elasticsearch.ts` was run to confirm it re-indexes existing
  `sent` rows.
- The frontend dashboard was exercised manually in the browser: Google
  login, compose via both pasted and CSV-uploaded recipients (including
  the invalid/duplicate-recipient states surfaced by
  `parseRecipients.ts`), the scheduled/sent tables, search, and the
  Slack connect/disconnect card.
- `npm run typecheck:backend` and `npm run typecheck:frontend` both pass
  with no errors; `npm run build:backend` and `npm run build:frontend`
  both produce a clean production build.
- `npm audit` (repo root) reports 0 vulnerabilities.

No production email provider is used, so end-to-end delivery to a real
external inbox has not been tested — only Ethereal's fake-SMTP delivery
and preview URLs.

## Assumptions & Trade-offs

- **BullMQ delayed jobs, not cron** — chosen so precise per-email
  scheduling doesn't need a polling interval; the trade-off is one Redis
  job per recipient rather than a single periodic sweep.
- **Ethereal instead of a real SMTP provider** — real delivery
  infrastructure (SES, SendGrid, etc.) was out of scope; Ethereal gives a
  real SMTP round-trip and a viewable rendered message without needing
  real mailboxes or provider credentials.
- **Redis as the sole live rate-limit/lock authority, Postgres as a
  downstream audit only** (ADR-020) — keeps the hot path fast (one Lua
  round-trip) at the cost of the audit table not being independently
  authoritative if Redis and Postgres ever disagree.
- **The ADR-017 ambiguous delivery window is detected, not
  auto-resolved** — a crash between the `message_id` write and the
  `status = 'sent'` write is logged for manual review rather than
  guessed at, because auto-resending risks a real duplicate send and
  auto-skipping risks silently dropping a message that never went out.
- **Idempotency keys live in Postgres, not Redis** (ADR-018) — an
  architectural choice so the idempotency guarantee is not dependent on
  Redis's durability (by design, it would survive a Redis restart or
  eviction, though that scenario itself was not part of this project's
  testing), using the database's own unique-constraint serialization
  rather than an application-level lock.
- **No campaign-level override of the sender-wide rate limit** — a
  campaign can set its own (lower or equal) hourly cap, but the
  sender-wide cap is env-configured only, so one campaign can't grant
  itself more send volume than the sender is allowed overall.
- **No automated test suite** — correctness was validated through the
  manual/live scenarios listed above (concurrency race, crash-window
  reproduction, real OAuth flows) rather than unit/integration tests.

## Demo

[Demo video — add link before submission]
