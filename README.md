# ReachInbox Email Scheduler

A restart-safe, rate-limited email campaign scheduler. See
[`docs/architecture.md`](./docs/architecture.md) for how the system works,
[`docs/decision.md`](./docs/decision.md) for why it's built this way, and
[`docs/plan.md`](./docs/plan.md) for the build sequence.

**Status:** Backend is functionally complete — scheduling, delivery,
reliability/idempotency, rate limiting, the campaign/senders/emails read
API, Elasticsearch search, Bull Board, Google OAuth + sessions, and Slack
OAuth + rate-limit notifications all exist and are wired together. The
Next.js frontend is a real dashboard connected to this backend — login,
scheduled/sent tables, compose (CSV/text recipients), Slack connect card,
and search — no mock data. This README will be expanded into the full
submission README later; for now it covers what's needed to run what
exists.

## Prerequisites

- Node.js 20+ and npm
- Docker (with Compose)

## Setup

```bash
cp .env.example .env
npm install
```

This is an npm-workspaces monorepo (`backend/`, `frontend/`) — a single
`npm install` at the repo root installs both workspaces.

## Running the infrastructure

```bash
docker compose up -d
docker compose ps   # postgres, redis, elasticsearch should all be "healthy"
```

> **Port note:** Postgres is exposed on host port **5433**, not 5432. If
> your machine already has a native Postgres bound to `127.0.0.1:5432`
> (common with Postgres.app / Homebrew), Docker's `5432:5432` mapping would
> silently connect to that instead of this project's container. `.env.example`
> already points `DATABASE_URL` at `5433`; if that port is also taken on
> your machine, change the mapping in `docker-compose.yml` and the port in
> your `.env` together.

## Database

```bash
npm run db:migrate   # applies Prisma migrations
npm run db:seed       # 2 dev users, 3 senders, 4 campaigns, 8 emails
```

Seeded senders use placeholder Ethereal credentials (`@ethereal.invalid`) —
real sends need a real Ethereal test account's `user`/`pass` written onto a
`senders` row (Ethereal accounts are created via
`nodemailer.createTestAccount()`, free and instant, but not created
automatically — see ADR-011).

## Running the backend

```bash
npm run dev:backend     # API on :4000
npm run dev:worker      # BullMQ worker — separate process, run alongside the API
```

```bash
curl http://localhost:4000/health
```

returns `200` once the API can reach Postgres and Redis. If a required
environment variable is missing, the process fails immediately on boot with
a list of what's missing.

Other backend scripts: `npm run build:backend`, `npm run typecheck:backend`,
`npm run db:studio` (Prisma Studio), `npm run db:migrate`, `npm run db:seed`.

## Google OAuth setup

1. Create an OAuth 2.0 Client ID (Web application) at
   [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Add an authorized redirect URI: `{API_URL}/auth/google/callback`
   (`http://localhost:4000/auth/google/callback` for local dev).
3. Put the client id/secret in `.env` as `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET`.
4. Visit `http://localhost:4000/auth/google` in a browser to sign in;
   `GET /auth/me` reflects the session, `POST /auth/logout` clears it.

Without real credentials, the OAuth code path still runs end-to-end up to
Google's own consent screen (the redirect URL, state/CSRF handling, and
token-exchange error handling are all real and testable) — only the actual
Google login itself needs a registered app.

## Slack OAuth setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
   with the `incoming-webhook` OAuth scope.
2. Add a redirect URL: `{API_URL}/slack/callback`.
3. Put the client id/secret in `.env` as `SLACK_CLIENT_ID` /
   `SLACK_CLIENT_SECRET`.
4. With a session cookie set (via Google login above), visit
   `http://localhost:4000/slack/install` to connect.

When a sender's hourly limit is hit, the worker posts a rate-limit
notification to the connected Slack destination — deduplicated per
`(sender, hour window)`, and a complete no-op (never a crash, never affects
the reschedule) if nothing is connected.

## Elasticsearch

Search is a derived index over `emails` — Postgres remains the source of
truth (ADR-010). Only successful sends are indexed on the hot path; if the
index falls behind (e.g. after an ES outage), run:

```bash
cd backend && npx tsx scripts/backfill-elasticsearch.ts
```

to re-index every `sent` email from Postgres. `GET /emails/search?q=...`
is scoped to the caller's own emails.

## Bull Board

`http://localhost:4000/admin/queues` — gated by session + the
`ADMIN_EMAILS` allow-list (comma-separated emails in `.env`).

## Running the frontend

```bash
cp frontend/.env.example frontend/.env.local
npm run dev:frontend
```

Loads at `http://localhost:3000`. `frontend/.env.local` sets
`NEXT_PUBLIC_API_URL` (default `http://localhost:4000`) — the frontend and
API are separate origins; the API's session cookie lives on the API's own
origin and is sent automatically on credentialed cross-origin requests
(`credentials: "include"` in `frontend/src/lib/api.ts`), gated by CORS on
the API side (`backend/src/app.ts`, restricted to `FRONTEND_URL`).

Flow: `/login` → "Continue with Google" navigates the browser to the API's
`/auth/google` (a real top-level redirect, not a fetch) → Google → the
API's callback sets the session cookie and redirects back to
`/dashboard`. Logout calls `POST /auth/logout` on the API.

Other frontend scripts: `npm run build:frontend`, `npm run typecheck:frontend`,
`npm run lint --workspace frontend`.

## Environment variables

`.env.example` (repo root) lists every backend variable, matching
`docs/architecture.md`'s documented list exactly, with setup notes for the
Google/Slack credentials above. `frontend/.env.example` covers the
frontend's one variable, `NEXT_PUBLIC_API_URL`, which is separate from
that list (a frontend build-time concern, not part of the backend's
documented environment).
