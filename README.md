# ReachInbox Email Scheduler

A restart-safe, rate-limited email campaign scheduler. See
[`docs/architecture.md`](./docs/architecture.md) for how the system works,
[`docs/decision.md`](./docs/decision.md) for why it's built this way, and
[`docs/plan.md`](./docs/plan.md) for the build sequence.

**Status:** Phase 1 (project foundation) complete — infrastructure,
environment validation, and a `/health` endpoint. No application features
(scheduling, auth, rate limiting) exist yet. This README will be expanded
into the full submission README in Phase 14; for now it only covers what's
needed to run what exists.

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

## Running the backend

```bash
npm run dev:backend
curl http://localhost:4000/health
```

`/health` returns `200` with `{"status":"ok", ...}` once the API can reach
Postgres and Redis (Elasticsearch is intentionally not part of this check —
see `docs/architecture.md`'s Elasticsearch section for why). If a required
environment variable is missing, the process fails immediately on boot with
a list of what's missing, rather than starting in a broken state.

Other backend scripts: `npm run build:backend` (compiles to `backend/dist`),
`npm run typecheck:backend`.

## Running the frontend

```bash
npm run dev:frontend
```

Loads at `http://localhost:3000` — currently a minimal shell page only; no
dashboard, auth, or campaign UI yet (that's Phase 11).

Other frontend scripts: `npm run build:frontend`, `npm run typecheck:frontend`,
`npm run lint --workspace frontend`.

## Environment variables

`.env.example` lists every variable this system uses, matching
`docs/architecture.md`'s documented list exactly. Google/Slack OAuth
variables are placeholders until Phases 7–8 add those integrations; they
must still be *present* (even as placeholders) for the backend's startup
validation to pass.
