# Implementation Plan

This is the **build roadmap** for the 48-hour assignment window: what to do,
in what order, and how to know each phase is actually done. It assumes the
design in [`architecture.md`](./architecture.md) and does not re-derive it —
where a phase says "implement the atomic claim," the mechanism is defined
there.

**Priority labels**, used on every task:

```text
P0 = mandatory — the assignment is incomplete without this
P1 = important polish — expected of a strong submission, but the
     assignment still "works" without it
P2 = optional — nice to have if time remains; drop first under time pressure
```

**Rule for the 48 hours:** P0 work is never traded away for P1/P2 work. If
time runs short, the cut lands on P2 first, then P1, in the reverse of the
phase order below (cut Phase 12's optional test cases before cutting Phase
5's core rate-limit logic). The phase order itself is deliberately
front-loaded with the riskiest, most load-bearing mechanics (delayed jobs,
restart survival, idempotency) so that if time runs out, what's already
working is the hardest and most heavily-graded part.

---

## Phase 1 — Project foundation

**Goal.** A monorepo that starts, with infrastructure up and a health check
passing, before any real feature exists.

**Tasks (all P0 unless noted).**
- Scaffold the monorepo: `backend/`, `frontend/`, root `docs/`.
- `backend`: TypeScript + Express project, `server.ts` entry point.
- `frontend`: Next.js + TypeScript + Tailwind project.
- `docker-compose.yml`: `postgres`, `redis` (AOF on), `elasticsearch`, each
  with a named volume.
- Environment validation on boot (e.g. a `zod` schema over `process.env`)
  that fails fast with a clear message if a required variable is missing —
  **P1**, but cheap and prevents an entire class of "works on my machine"
  bugs later.
- `GET /health` on the API returning `200` once it can reach Postgres and
  Redis.

**Definition of done.** `docker compose up` brings up all three
infrastructure services; `npm run dev` (or equivalent) starts the API and it
serves `/health` as `200`.

**Verification.** `curl localhost:<port>/health` → `200`. Stopping
`docker compose` and restarting the API produces a clear connection error,
not a silent hang — confirms the env validation is real.

---

## Phase 2 — Database

**Goal.** The schema from `architecture.md`'s data model exists, migrated,
indexed, and seeded.

**Tasks (P0 unless noted).**
- Prisma schema for all seven tables (`users`, `senders`, `campaigns`,
  `emails`, `rate_windows`, `slack_connections`, `idempotency_keys` —
  the last added per ADR-018).
- `campaigns` carries `sender_id` (the single sender selected at creation,
  per ADR-019); every `emails` row inherits `sender_id` from its campaign.
- `campaigns` also carries required, non-null scheduling controls —
  `start_at`, `delay_between_emails_ms`, `hourly_limit` (ADR-021, ADR-022)
  — resolved from the compose UI's input or the `MIN_DELAY_MS` /
  `MAX_EMAILS_PER_HOUR_PER_SENDER` defaults at creation time, and persisted;
  these are functional values, not display-only defaults.
- Migration generated and committed.
- Constraints: `emails(job_id)` unique, `emails(campaign_id, to_email)`
  unique, `rate_windows(sender_id, window_start)` unique,
  `idempotency_keys(user_id, key)` unique.
- Indexes: `emails(status, scheduled_at)`.
- Seed script — **P1**: 1–2 users, 2–3 senders (so multi-sender behavior is
  visible without manual setup every time — senders remain seed/dev-created
  only; there is no `POST /senders` endpoint, per ADR-019).

**Definition of done.** `prisma migrate dev` runs clean from an empty
database. The seed script populates enough data to exercise multi-sender
flows immediately.

**Verification.** Inspect the schema directly (`psql` or Prisma Studio):
confirm both unique constraints exist and reject a duplicate insert when
tested manually.

---

## Phase 3 — BullMQ + worker (simplest possible path)

**Goal.** Prove the core mechanic — delayed job → worker → send → mark sent
— end to end, with a single hardcoded email, before any other feature is
built on top of it. This phase exists specifically to de-risk the part of
the assignment that everything else depends on.

**Tasks (P0).**
- BullMQ `Queue` and `Worker` wired to Redis.
- A throwaway script or route that inserts one `emails` row and enqueues one
  delayed job (delay a fixed 30–60 seconds, hardcoded, no rate limiting yet).
- Worker picks up the job, sends through Ethereal (`nodemailer` +
  `createTestAccount`), marks the row `sent`, logs the preview URL.

**Definition of done.** Scheduling one email results in it actually arriving
in an Ethereal test inbox at approximately the right time, with the row
updated to `sent`.

**Verification — restart persistence, checked here first, before anything
else is built:**
1. Enqueue an email 2+ minutes out.
2. Kill the worker process.
3. Wait past the original delay.
4. Start the worker again.
5. Confirm the email still sends, at (approximately) the originally
   scheduled time, and is marked `sent` exactly once.

This is the single most important checkpoint in the whole plan — if this
doesn't hold here, with nothing else in the way, it won't hold later either.

---

## Phase 4 — Reliability

**Goal.** Turn the "happy path" from Phase 3 into something that can't
double-send or silently lose work.

**Tasks (P0 unless noted).**
- Atomic claim: `UPDATE emails SET status='processing' ... WHERE
  status='scheduled'` before any send attempt.
- Idempotency via job id = email id; verify re-adding a job with an existing
  id is a no-op.
- Duplicate protection: confirm the unique constraints from Phase 2 actually
  reject duplicate rows under a simulated retried request.
- Boot-time reconciliation: scheduled rows with no live job get
  re-enqueued; stuck `processing` rows past a timeout are returned to
  `scheduled`.
- `Idempotency-Key` header support on `POST /campaigns` — **P1** for a
  single-email test flow, but effectively P0 once Phase 6 makes campaigns
  the real entry point, since a flaky-network retry there could otherwise
  double-schedule an entire recipient list.

**Definition of done.** Manually killing the worker mid-send (e.g. a
`process.exit()` inserted right after the SMTP call but before the status
write) and restarting it results in the ambiguous case being logged, not a
second email being sent blindly.

**Verification.** Repeat the Phase 3 restart test, but this time also: (a)
manually re-add a job with an id that's already `sent` and confirm it's a
no-op; (b) submit the same `POST /campaigns` payload with the same
`Idempotency-Key` twice and confirm only one campaign is created.

---

## Phase 5 — Rate limiting

**Goal.** All three throughput controls from `architecture.md`, safe across
concurrent workers.

**Tasks (P0 unless noted).**
- `WORKER_CONCURRENCY` wired to the BullMQ `Worker` constructor.
- Redis per-sender lock for `MIN_DELAY_MS`, with reschedule-on-contention —
  retained unmodified as a sender-wide safety floor, layered under each
  campaign's own `delay_between_emails_ms` (ADR-021): realized spacing is
  `max(campaign.delay_between_emails_ms, MIN_DELAY_MS)`.
- Redis Lua script for **two** hourly counters, checked and incremented
  atomically together (ADR-022): `rate:{senderId}:{hourWindow}` (sender-wide
  safety cap, fixed at `MAX_EMAILS_PER_HOUR_PER_SENDER`, never per-campaign)
  and `rate:campaign:{campaignId}:{hourWindow}` (that campaign's own
  `hourly_limit`). A send is permitted only when both grant a slot.
- Reschedule-not-drop logic when *either* limit is hit, with order
  preservation per campaign (offset by original relative position within
  the overflow).
- On a successful send, upsert the `rate_windows` row for `(sender_id,
  window_start)` as a durable audit write — downstream of the Redis check,
  never gating it (ADR-020).
- 1000+ email behavior — no code path unique to this case is required, but
  it must be verified (see below) that the same logic holds at volume.
- Load test script that schedules many emails and asserts none are dropped
  — **P1**: valuable evidence for the README/demo, not itself a requirement.

**Definition of done.** With `MAX_EMAILS_PER_HOUR_PER_SENDER` set low (e.g.
3) and 10 emails scheduled for one sender/one campaign at the same time,
exactly 3 send in the first window and the remaining 7 are visibly
rescheduled into subsequent windows, in original order, none marked
`failed`. Separately: with the sender cap left high but a campaign's own
`hourly_limit` set low, the same behavior holds bounded by the campaign
limit instead; and with two campaigns on one sender each individually under
the sender cap, their combined sends in a window never exceed the sender
cap (ADR-022's worked example).

**Verification.**
- Run two worker processes concurrently against the same low limit; confirm
  the total sent in the first window never exceeds the configured cap
  (proves the Lua script is actually atomic across processes, not just
  within one).
- Confirm a job blocked on the minimum-delay lock is rescheduled, not
  retried in a tight loop.
- Two campaigns on the same sender, each configured under the sender's
  cap (e.g. sender cap 200/hour, campaign A 50/hour, campaign B 100/hour):
  confirm neither campaign exceeds its own limit, and confirm their combined
  total in one window never exceeds the sender's 200/hour cap.
- Schedule 1000 rows for one sender (this can be a script directly inserting
  rows + enqueueing jobs, no need to actually let all 1000 send through
  Ethereal) and confirm the count of jobs due "now" vs. spread into future
  windows matches the arithmetic in `architecture.md`'s worked example.

---

## Phase 6 — API

**Goal.** The full `POST /campaigns` flow and the read endpoints, replacing
the Phase 3 throwaway script.

**Tasks (P0).**
- `POST /campaigns`: require `senderId` in the body, validate it belongs to
  the authenticated user (reject before writing anything if not, per
  ADR-019); accept optional `startAt`/`delayBetweenEmailsMs`/`hourlyLimit`,
  resolving unset ones from `MIN_DELAY_MS`/`MAX_EMAILS_PER_HOUR_PER_SENDER`
  and persisting the resolved values on the campaign row (ADR-021,
  ADR-022) — these are functional scheduling controls, not display-only
  fields; parse recipients, insert campaign + email rows in one
  transaction (every email inheriting the campaign's `sender_id`, each
  `scheduled_at` computed from the campaign's `start_at` and
  `delay_between_emails_ms`), `addBulk` the jobs, honor `Idempotency-Key`
  against the `idempotency_keys` table (ADR-018).
- `GET /emails?status=scheduled` and `?status=sent`, paginated.
- `GET /emails/search` (stub acceptable until Phase 9 wires real
  Elasticsearch; can proxy to a simple Postgres `ILIKE` query in the
  interim if Elasticsearch isn't ready yet — **P1** fallback, not required
  if Phase 9 lands on schedule).
- `GET /senders`, including current-hour usage (read the same Redis
  counters Phase 5 writes).

**Definition of done.** A Postman/curl-driven flow can schedule a campaign
for multiple recipients and see it move through Scheduled to Sent purely via
these endpoints, with no direct DB manipulation.

**Verification.** Scripted Postman collection (or a short integration test)
covering: create campaign → list scheduled → wait → list sent → search.

---

## Phase 7 — Google OAuth

**Goal.** Real login, replacing any dev bypass used up to this point.

**Tasks (P0).**
- `GET /auth/google` → redirect; `GET /auth/google/callback` → exchange
  code, verify ID token, upsert `users`, set session cookie.
- `GET /auth/me`, `POST /auth/logout`.
- Session-cookie middleware applied to every route from Phase 6 onward.

**Definition of done.** A real Google account can log in, `/auth/me`
reflects it, logout clears the session, and every previously-open API route
now requires the cookie.

**Verification.** Manual login through a browser; confirm a request to a
protected route with no cookie returns `401`.

---

## Phase 8 — Slack OAuth

**Goal.** Real Slack connect flow and the actual rate-limit notification,
wired against the Phase 5 rate limiter.

**Tasks (P0).**
- Register a real Slack app in a free/test workspace; register the redirect
  URL.
- `GET /slack/install`, `GET /slack/callback` (signed `state` carrying the
  user id), `GET /slack/status`, `DELETE /slack`.
- Worker-side notification: on first blocked attempt per `(sender,
  hourWindow)`, look up the connection and post; `SET NX` dedup key so only
  one message goes out per sender per window.
- No-crash-when-disconnected path, and "works without redeploy once
  connected" — verify both explicitly (see below), since they're easy to
  silently break with a caching shortcut.

**Definition of done.** Lowering the hourly cap and triggering it in a
connected workspace produces exactly one real Slack message, visible in the
demo.

**Verification.**
1. With Slack **not** connected, trigger a rate-limit hit; confirm no crash
   and no message.
2. Connect Slack.
3. Trigger a rate-limit hit again, in the **same running process** (no
   restart) — confirm a message now arrives, proving the connection lookup
   isn't cached at startup.
4. Trigger several more blocked jobs for the same sender in the same hour;
   confirm only one message total for that window.

---

## Phase 9 — Elasticsearch

**Goal.** Real search, replacing any Phase 6 fallback.

**Tasks (P0 unless noted).**
- Index creation/mapping for the `emails` index.
- Index-on-write: creation and every status change updates the document
  (id = email's Postgres id).
- `GET /emails/search` wired to a real `multi_match` query.
- Failure isolation: wrap the indexing call so an Elasticsearch error is
  logged and swallowed, never propagated to fail the send or the status
  write.
- Reindex outbox for catching up after an outage — **P1**: the failure
  isolation above is P0 (required so ES can't break sending); a background
  catch-up mechanism is valuable but the assignment doesn't require search
  to be perfectly consistent, only that it doesn't take down the sender.

**Definition of done.** Searching for a recipient's address or a subject
keyword returns the matching email, and stopping the Elasticsearch container
entirely does not stop new emails from sending.

**Verification.** Stop the `elasticsearch` container; schedule and send an
email; confirm it still reaches `sent` and no error surfaces to the API
caller. Restart Elasticsearch; confirm subsequent sends are searchable
again.

---

## Phase 10 — Bull Board

**Goal.** Live queue visibility, admin-gated.

**Tasks (P0).**
- Mount `@bull-board/express` at `/admin/queues` against the real queue(s).
- Gate behind session cookie + `ADMIN_EMAILS` allow-list.

**Definition of done.** An admin-listed account sees live waiting/delayed/
active/completed/failed counts that change as jobs are scheduled and
processed; a non-admin logged-in account is refused.

**Verification.** Load `/admin/queues` as both an allow-listed and a
non-allow-listed account.

---

## Phase 11 — Frontend

**Goal.** The dashboard, matching the Figma, built in dependency order so
each piece is checkable as soon as it exists.

**Tasks, in build order (P0 unless noted).**
1. `/login` — Google sign-in button.
2. Dashboard shell — layout, route guard against `/auth/me`.
3. Header — name, email, avatar, logout.
4. Scheduled table — wired to `GET /emails?status=scheduled`, with loading
   and empty states.
5. Sent table — wired to `GET /emails?status=sent`, with loading and empty
   states.
6. Compose modal — sender selector (populated from `GET /senders`, required,
   per ADR-019), subject/body fields, open/close, validation only (no
   submission yet).
7. CSV upload — client-side parsing, valid/invalid address count shown in
   the modal.
8. Scheduling — wire the modal's Schedule button to `POST /campaigns`,
   including start time / delay / hourly limit fields — these are
   functional scheduling controls persisted per campaign and actually
   enforced (ADR-021, ADR-022), not decorative defaults.
9. Search — a search box wired to `GET /emails/search`.
10. Slack connection card — status display, connect/disconnect.
11. Loading/error/empty states pass — **P1**: an explicit second pass over
    every view above to make sure each one handles its slow, empty, and
    failed states, not just its happy path.

**Definition of done.** The full flow — log in, compose with a CSV upload,
schedule, watch it move from Scheduled to Sent, search for it, connect Slack
— works end to end from the UI with no direct API calls needed.

**Verification.** Manual click-through of the full flow above, once with an
empty account (confirms empty states) and once with seeded data (confirms
the happy path and loading states under a throttled network).

---

## Phase 12 — Testing

**Goal.** Explicit evidence for the mechanisms that are easy to claim and
hard to actually verify by eye.

**Test cases (P0 unless noted — grouped by what they protect):**

*Core scheduling (P0):*
```text
basic scheduling            one email, sends at the right time
delayed execution           scheduled_at in the future is honored, not sent early
multiple recipients         one campaign, N rows, N jobs
multiple senders            two senders' jobs don't interfere
```

*Concurrency & rate limiting (P0):*
```text
worker concurrency          raising WORKER_CONCURRENCY increases parallel sends
minimum delay               two jobs for one sender never send < max(campaign
                             delay, MIN_DELAY_MS) apart
campaign hourly limit       the (N+1)th send for one campaign in a window is
                             blocked, not sent, even if the sender cap has room
sender safety limit         two campaigns on one sender, each under its own
                             limit, still cannot jointly exceed the sender cap
rate-limit rescheduling     a blocked job (either limit) reappears in the next
                             window, in order
```

*Reliability (P0):*
```text
duplicate API request       same Idempotency-Key twice → one campaign
duplicate BullMQ job        re-adding an existing job id → no-op, no double send
server restart              API restart mid-flight → no effect on scheduled jobs
worker restart              worker restart mid-flight → reconciliation recovers it
stuck processing            a row stuck in processing past the timeout is recovered
```

*Failure isolation (P0):*
```text
SMTP failure                a send failure marks the row failed, doesn't crash the worker
Elasticsearch failure       ES down doesn't block sending (Phase 9's verification, repeated as a regression check)
```

*Scale (P1 — verified via the Phase 5 load script, not a full Ethereal run):*
```text
1000+ scheduled emails      matches the worked example's arithmetic
```

*Auth & integrations (P0):*
```text
Google login
logout
Slack disconnect/reconnect   (Phase 8's verification, repeated as a regression check)
Slack notification           (same)
```

**Definition of done.** Every P0 case above has been run at least once,
manually or scripted, since the feature it protects was last touched, and
the result is recorded (a short note or a passing script output) rather than
just remembered.

**Verification.** This phase *is* the verification for every earlier phase —
its own "check" is simply that the list above has no unchecked P0 item
before Phase 13 starts.

---

## Phase 13 — Demo

**Goal.** A single, rehearsed, under-5-minute recording that hits every
required beat without narration filler.

**Sequence:**

| Time | Segment |
| --- | --- |
| 0:00–0:20 | Log in with Google, show header (name/email/avatar) |
| 0:20–0:40 | Connect Slack from the dashboard |
| 0:40–1:20 | Compose: upload a CSV of ~8 addresses, set a low hourly limit (e.g. 3) and a short delay, schedule |
| 1:20–2:10 | Watch Scheduled drain into Sent; open an Ethereal preview link; show Bull Board's live counts |
| 2:10–2:50 | Show the Slack message arriving the moment the cap is hit; show the overflow rows rescheduled into the next window |
| 2:50–4:00 | **Restart scenario:** schedule a fresh batch a few minutes out, stop the API and worker, start them again, show the batch still sends on time with no duplicates |
| 4:00–4:20 | Search for one of the sent addresses |
| 4:20–5:00 | Buffer / brief narration of what's off-screen (Phase 12's test suite, README) |

**Definition of done.** A single take (or lightly cut) recording, at or
under 5 minutes, covering every bullet in the assignment's demo
requirements list without needing a live narrator to explain what's
happening.

**Verification.** Watch it back once, stopwatch in hand, checking it against
the assignment's own demo checklist line by line.

---

## Phase 14 — Submission

**Goal.** Everything the grader needs to run and evaluate the project
without asking a follow-up question.

**Tasks (P0 unless noted).**
- README covering: running the backend (Express, Redis, DB, worker),
  running the frontend, Ethereal setup, all environment variables,
  architecture overview (scheduling, persistence, rate limiting/concurrency
  — this can and should point back at `architecture.md` rather than
  duplicate it), and the feature-to-requirement mapping.
- `.env.example` listing every variable from `architecture.md`'s
  environment-variables section, with safe placeholder/default values.
- Private GitHub repository created.
- Collaborators added (`Mitrajit`, `Yadav036`).
- Demo video uploaded/linked from Phase 13.
- ClickUp submission form filled in with the repo link, video link, and any
  notes.
- Final verification pass — **P1** but treated as a hard gate before
  submitting: fresh clone, `docker compose up`, `.env` filled from
  `.env.example`, both processes started from a clean checkout, confirming
  the README's own instructions are actually sufficient (catches "works on
  my machine because of a leftover local state" problems).

**Definition of done.** A reviewer with only the repository, the README, and
the video can run the project and verify every requirement without needing
to ask the author anything.

**Verification.** The final-verification task above, performed literally:
clone into a clean directory and follow the README top to bottom.
