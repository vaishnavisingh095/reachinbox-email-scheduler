# Architecture Decision Records

This document explains **why** the system is built the way
[`architecture.md`](./architecture.md) describes, and what was considered
and rejected along the way. Where a decision is a direct, non-negotiable
consequence of the assignment brief (e.g. "no cron"), that's stated plainly
rather than dressed up as a close call.

---

## ADR-001: PostgreSQL as the source of truth

**Status:** Accepted

**Context.** The system has several stores that could plausibly hold "what
should happen and what has happened": Postgres, Redis (via BullMQ), and
Elasticsearch. Exactly one of them needs to be authoritative, or every
restart and every idempotency check becomes a question of which store to
trust.

**Decision.** PostgreSQL is the single source of truth for every email's
intent and status. Redis holds only timing/delivery mechanics; Elasticsearch
holds only a search-optimized copy.

**Why.** Postgres offers transactions and unique constraints, which is
exactly the shape idempotency needs ("has this recipient already been
scheduled for this campaign?" is a constraint, not application logic to get
right every time). It's also the store most naturally backed up and
inspected by a human during grading — "what's the state of email X" should
have one unambiguous answer.

**Alternatives considered.** Making Redis (via BullMQ job state) the
authority was rejected: BullMQ job state answers "has this job run," not
"has this email actually been delivered," and those are different questions
once retries and stalled-job detection are involved. Making Elasticsearch
authoritative was rejected outright — it has no transactions and is
explicitly a derived index in this design (see ADR-010).

**Trade-offs.** Every status change now costs a Postgres write in addition
to whatever else is happening (a Redis lock check, an ES update). This is an
acceptable cost for a system whose throughput is already capped in the
hundreds-per-hour range by design (the rate limiter), not thousands per
second.

---

## ADR-002: BullMQ + Redis delayed jobs instead of cron

**Status:** Accepted

**Context.** The assignment explicitly forbids cron (OS-level and Node
libraries) and explicitly requires a mechanism that is restart-safe. Several
mechanisms could schedule "run this at time T."

**Decision.** BullMQ delayed jobs, backed by Redis.

**Why.** A BullMQ delayed job stores its own due time as data in Redis and
is moved to the waiting list by BullMQ's own internals when that time
arrives — no periodic tick, no external scheduler process, and the due time
survives a restart of the API/worker because it isn't held in either
process's memory.

**Alternatives considered.**

- **Cron / `node-cron` / `agenda`.** Explicitly disallowed by the
  assignment. Also structurally the wrong tool here regardless: cron-style
  scheduling works by periodically scanning "what's due now" against the
  whole set of pending work on a fixed tick, which doesn't map cleanly onto
  "each email has its own, individually assigned due time" — every tick
  would have to re-derive who's due, and the polling interval becomes a
  floor on scheduling precision.
- **`setTimeout`-only scheduling.** A `setTimeout` is destroyed the moment
  the process restarts — it lives in process memory, not in any durable
  store. This fails the restart requirement outright, not as a matter of
  degree.
- **Database polling** (a loop that repeatedly queries
  `WHERE scheduled_at <= now`). This is viable and restart-safe in principle
  (the due time lives in Postgres), but it reintroduces a cron-shaped
  problem: a polling interval, and therefore a floor on precision and a
  trade-off between poll frequency and database load, that a delayed-job
  primitive avoids by letting Redis do that work event-driven rather than by
  polling. Also less naturally supports per-job retry, concurrency and
  priority semantics, which BullMQ provides.

**Trade-offs.** This adds a dependency on Redis staying up (mitigated by AOF
persistence) and on BullMQ's own correctness. Accepted, because Redis is
already required for the rate-limit counters, so it isn't a new
infrastructure dependency.

---

## ADR-003: One BullMQ job per email recipient

**Status:** Accepted

**Context.** A campaign with N recipients could be represented as one job
that fans out to N sends, or as N independent jobs.

**Decision.** One job per recipient.

**Why, across each dimension that matters:**

- **Retries.** A failure sending to recipient #47 of 1000 should not
  require redoing #1–46. Per-recipient jobs make BullMQ's own retry
  mechanism operate at the right granularity for free.
- **Status.** "Scheduled / processing / sent / failed" is naturally a
  per-recipient concept (recipient A can be sent while recipient B is rate
  limited). A single fan-out job would need to reimplement per-recipient
  status tracking inside the job's own logic instead of getting it from job
  state.
- **Rate limiting.** The Redis lock and Lua counter operate per send
  attempt. A single job trying to send 1000 emails in a loop would have to
  manually pause and resume itself mid-job to respect the limiter —
  awkward, and it would hold one BullMQ job "active" for a potentially very
  long, rate-limited duration, which fights the concurrency model rather
  than using it.
- **Idempotency.** A per-recipient unique job id (ADR-004) only makes sense
  if a job corresponds to exactly one email.
- **Scheduling.** Different recipients within one campaign can end up with
  different `scheduled_at` values once rate-limit overflow pushes some of
  them later (see `architecture.md`'s 1000+ example) — that's only
  representable if each recipient has its own job to independently
  reschedule.

**Alternatives considered.** One job per campaign, with the worker looping
over recipients internally, was rejected for the reasons above — it works
for small campaigns but degrades exactly where the assignment's "1000+"
requirement stresses it.

**Trade-offs.** More jobs in Redis to track for a large campaign. Mitigated
by `addBulk` (one pipelined call to create all of them) rather than N
sequential `add` calls.

---

## ADR-004: Email id as BullMQ job id

**Status:** Accepted

**Context.** Idempotency requires a way to say "this specific unit of work
has already been enqueued/executed" without an extra lookup table.

**Decision.** The BullMQ job id for an email's send job is exactly that
email's Postgres `id`.

**Why.** BullMQ already refuses to add a second job with an id that exists
in the queue — using the email id directly gets "adding this job twice is a
no-op" for free, with no extra Redis key or table needed to map one id to
the other. It also makes reconciliation trivial: "does this scheduled row
have a live job" is a direct lookup by a value the row already has.

**Alternatives considered.** A separate generated job id, stored on the
`emails` row as a foreign key to the job. Rejected as unnecessary
indirection — it solves no problem that reusing the email id doesn't already
solve, and adds a column and a place for the two ids to drift apart.

**Trade-offs.** None significant; this is a straightforwardly simpler
option, not a compromise.

---

## ADR-005: Atomic PostgreSQL status claim for idempotency

**Status:** Accepted

**Context.** BullMQ guarantees at-least-once job execution, not exactly-once
— a job can be delivered to a worker more than once (e.g. after a
stalled-job timeout misjudges a slow-but-alive worker). Something has to
turn "delivered twice" into "executed once."

**Decision.** A single conditional SQL statement —
`UPDATE emails SET status='processing' WHERE id=$1 AND status='scheduled'`
— is the sole gate before any externally visible action (rate-limit check,
SMTP send). A second delivery of the same job finds zero rows affected and
exits.

**Why.** Doing the check and the write in one SQL statement removes the
window between "is this scheduled?" and "mark it processing" where two
concurrent executions could both pass the check before either writes —
which a separate `SELECT` then `UPDATE` would not close.

**Alternatives considered.** A Redis-based lock (`SET NX`) per email as the
claim mechanism, mirroring the sender-level lock used elsewhere. Rejected in
favor of the SQL-level claim specifically because the claim's outcome
(`scheduled`/`processing`/`sent`) is itself state that must live in Postgres
regardless (ADR-001) — adding a Redis lock on top would mean two systems
could disagree about whether an email was claimed, for no benefit over the
single-statement Postgres approach.

**Trade-offs.** None significant — this is the minimum mechanism that
closes the race, not an over-engineered one.

---

## ADR-006: Redis-backed per-sender minimum delay

**Status:** Accepted

**Context.** The assignment requires a minimum delay between individual
sends, "safe when multiple jobs run in parallel." An in-process delay (a
`sleep` in the worker before sending) only constrains that one worker's own
timeline.

**Decision.** A per-sender Redis lock, set with `SET ... NX PX
<MIN_DELAY_MS>`, that must be acquired before a send for that sender; failure
to acquire reschedules the job rather than blocking on it.

**Why.** The requirement is about **wall-clock spacing between actual
sends for a given sender**, not about keeping one worker busy for a fixed
duration. A Redis lock is visible to every worker process and every
concurrent job slot, so it's the only version of "minimum delay" that holds
regardless of how many workers or how much concurrency is configured.

**Alternatives considered.** BullMQ's own rate limiter (`limiter` option on
the `Worker`) was considered, since the assignment mentions it as an option.
Rejected for this specific control because BullMQ's limiter is scoped to the
whole queue, not per sender — it would throttle all senders together, which
doesn't match "minimum delay between individual email sends" when that
phrase is read alongside the requirement to support multiple independent
senders. It remains a reasonable choice for a simpler, single-sender system;
it just doesn't fit this one's per-sender requirement.

**Trade-offs.** A blocked job is rescheduled (a small write) rather than
simply delayed in place, which is marginally more Redis/Postgres traffic
than an in-memory sleep would cost — accepted, because the alternative
doesn't actually satisfy the requirement.

---

## ADR-007: Redis Lua atomic hourly rate limiter

**Status:** Accepted

**Context.** The hourly cap must be enforced safely across multiple worker
processes, per sender, without relying on in-memory counts (explicitly
required).

**Decision.** A single Lua script, run via `EVAL`, does the read-check-
increment as one atomic step against a Redis key
`rate:{senderId}:{hourWindow}`.

**Why.** Redis executes Lua scripts single-threadedly and atomically with
respect to all other commands — nothing can interleave between the script's
`GET` and its `INCR`. A plain `GET` followed by a separate `INCR` from
application code has exactly the race this must avoid: two workers could
both read "199," both decide they're under the cap, and both increment,
overshooting the limit.

**Alternatives considered.**

- **Redis `INCR` alone, checked after the fact** (increment first, then
  check if the result exceeds the cap). This is actually close to correct
  and simpler than the check-then-increment version, but requires a
  decrement on the "over cap" branch to avoid permanently inflating the
  counter for a rejected attempt — which reintroduces a second network
  round-trip that isn't atomic with the first, reopening a smaller version
  of the same race. The Lua script avoids this by never incrementing on a
  rejected attempt in the first place (see ADR-008).
- **Database-backed counter** (a Postgres row updated with
  `SELECT ... FOR UPDATE`). Viable, but adds row-lock contention to the
  database on the hot send path for a purely ephemeral, hourly-reset
  counter — Redis is the more natural fit for a value that's cheap to lose
  and trivial to recompute, and it's already required for BullMQ.

**Trade-offs.** The counter is a Redis value with a TTL, not a
Postgres row — if Redis loses the key mid-hour (despite AOF), a sender could
briefly exceed its cap after a Redis failure. This is explicitly accepted:
`rate_windows` in Postgres exists as a durable **audit** trail of what
actually happened, not as the enforcement mechanism, so a rare Redis data
loss event degrades the limiter's precision for one window rather than
breaking correctness elsewhere in the system.

---

## ADR-008: Reschedule rate-limited jobs instead of failing/dropping them

**Status:** Accepted

**Context.** The assignment is explicit: hitting the hourly limit must not
drop or permanently fail jobs.

**Decision.** A job that fails the Lua check is moved back to `scheduled`
with `scheduled_at` set to the next window (plus jitter and an order-
preserving offset), and a fresh BullMQ delayed job is added for it. The
rejected attempt never increments the counter (see ADR-007's discussion of
why check-then-increment, not increment-then-decrement, was chosen).

**Why.** This is close to a direct restatement of the requirement, so the
interesting decision is *where* the retry lives: as data (a new
`scheduled_at` and a new delayed job), not as an in-memory retry loop or a
BullMQ "delayed retry" backoff on the same job instance. Treating it as data
means the reschedule survives a restart just as any other scheduled email
would, and it shows up identically in the Scheduled table — a rate-limited
email looks exactly like any other scheduled email to the rest of the
system, which is the simplest possible way to satisfy "don't drop it."

**Alternatives considered.** Using BullMQ's built-in retry/backoff on the
same job (fail the job, let BullMQ retry it after a backoff) was considered.
Rejected because a job's "failed then retried" history in BullMQ is a
worse fit for the dashboard's Scheduled/Sent semantics than simply updating
`scheduled_at` and letting the row remain `scheduled` — the assignment wants
this to look like normal scheduling, not like error recovery.

**Trade-offs.** None significant relative to the alternative; this is the
more accurate representation of what's actually happening (the email isn't
an error case, it's just waiting for a later window).

---

## ADR-009: Fixed UTC hourly windows instead of sliding windows

**Status:** Accepted

**Context.** "Emails per hour" can be enforced as a fixed window (e.g.
everything between `09:00:00` and `09:59:59` UTC counts together) or a
sliding window (the last 3600 seconds, continuously).

**Decision.** Fixed UTC hourly windows, keyed as `rate:{senderId}:{window}`
where `window` is the hour truncated (e.g. `2026-09-28T09`).

**Why.** A fixed window is a single Redis key with a natural TTL (expire
after 2 hours) and a trivial "what window is this job in" computation
(truncate the timestamp). It's also what the assignment's own example env
var name suggests (`MAX_EMAILS_PER_HOUR_PER_SENDER`, not "per rolling hour"),
and it's simple enough to verify by eye during grading and the demo.

**Alternatives considered.** A sliding window (e.g. a sorted set of send
timestamps, counting how many fall within the last 3600 seconds of now) is
more precise — it prevents the boundary behavior below — but requires a
sorted-set per sender with an eviction step on every check, more Redis
operations per send, and is harder to reason about at a glance in a demo or
a code review.

**Trade-offs — stated plainly, not hidden.** A sender can send its full cap
at `09:59` and again at `10:00`, i.e. up to `2 × MAX_EMAILS_PER_HOUR_PER_SENDER`
emails within a two-minute span straddling the boundary. This is a real
behavioral looseness compared to a sliding window, and it's accepted as a
reasonable trade for the fixed window's simplicity, given the assignment
doesn't require strict rolling-window precision — only that the limit is
enforced, configurable, and safe across workers, all of which the fixed
window satisfies.

---

## ADR-010: Elasticsearch as a search/read layer, not source of truth

**Status:** Accepted

**Context.** Elasticsearch could be used as a genuine secondary datastore
(written to synchronously and trusted for reads) or as a derived,
best-effort index.

**Decision.** Elasticsearch is a derived index. Postgres remains
authoritative (ADR-001); Elasticsearch is rebuilt-from, never
rebuilt-to.

**Why.** The requirement is "make emails searchable," not "make
Elasticsearch a second system of record." Treating it as derived means an
Elasticsearch outage is a search-quality problem, not a correctness or
availability problem for the actual product function (scheduling and
sending mail) — which is the right failure mode given search is a
convenience feature layered on top of the core job.

**Alternatives considered.** Writing to Elasticsearch and Postgres
transactionally (or treating an ES write failure as a reason to fail the
whole operation) was rejected outright: it would mean a search-index outage
could stop emails from sending, which inverts the actual importance of the
two systems.

**Trade-offs.** Search can be briefly stale or (during an extended outage)
missing recent emails entirely, until the outbox/reconciliation catches it
up. Accepted as the correct trade given search is explicitly a read-side
convenience here.

---

## ADR-011: Ethereal SMTP for test delivery

**Status:** Accepted

**Context.** The assignment specifies Ethereal explicitly, so this ADR
exists mainly to record the consequence that follows from it, for
[ADR-017](#adr-017-at-most-once-normal-processing--explicit-handling-of-the-smtp-db-crash-window).

**Decision.** Ethereal Email via Nodemailer, one test account per `sender`
row (created once via `createTestAccount()` and persisted, not recreated
per send).

**Why.** Required by the assignment. Using one account per sender (rather
than one shared account for all senders) is what makes "multiple senders"
a real, independently-observable behavior rather than a label with no
backing difference.

**Alternatives considered.** None — this was specified, not chosen.

**Trade-offs.** Ethereal never delivers to a real inbox; "success" means an
accepted SMTP transaction with a preview URL, not confirmed delivery to a
human. This is inherent to the tool, not a shortcut taken in this design,
and it's noted here because it's directly relevant to how "sent" should be
interpreted throughout the rest of the documentation.

---

## ADR-012: Google OAuth authorization-code flow

**Status:** Accepted

**Context.** The assignment requires real Google login, "no mock."

**Decision.** Standard OAuth 2.0 authorization-code flow, server-side token
exchange, server-side ID token verification (signature and audience), HTTP-
only signed session cookie.

**Why.** The authorization-code flow keeps the client secret and the token
exchange entirely server-side — the frontend never sees a Google token, only
the resulting session cookie. Verifying the ID token server-side (rather
than trusting a subsequent call to a profile endpoint alone) is what makes
the login actually trustworthy rather than merely "looks logged in."

**Alternatives considered.** An implicit-flow or client-side-only
"Sign in with Google" button that hands a token straight to the frontend was
rejected: it would satisfy "real Google OAuth" only superficially, while
leaving the API with no server-verified identity to build a session on.

**Trade-offs.** Slightly more setup (registering OAuth credentials, a
callback route) than a mocked login. Accepted, since it's explicitly
required.

---

## ADR-013: Slack OAuth for live rate-limit notifications

**Status:** Accepted

**Context.** The assignment requires a real, live-verifiable Slack
notification on a rate-limit hit — explicitly "not a log line."

**Decision.** A real OAuth authorize flow per user/tenant, storing a token
and delivery target (incoming webhook or bot token + channel), with the
worker posting directly at the moment a limit is hit, deduplicated per
sender per hour window (`SET NX`).

**Why.** Only a real OAuth connection produces a message that actually lands
in a real Slack workspace during the demo, which is exactly what's being
graded. Posting from the worker (not the API) is necessary because the
worker is the process that actually observes the limit being hit — the API
has no visibility into that event at all.

**Alternatives considered.** A single, hardcoded incoming-webhook URL (no
OAuth, no per-user connection) was considered as a shortcut. Rejected: it
would satisfy "sends a real Slack message" but not "real OAuth authorize
flow" or "per user/tenant," both explicitly required.

**Trade-offs.** More setup than a hardcoded webhook (a real Slack app,
redirect URL registration). Accepted, since it's explicitly required.

---

## ADR-014: Bull Board for queue observability

**Status:** Accepted

**Decision.** `@bull-board/express`, mounted on the API process at
`/admin/queues`, gated by session + an admin allow-list.

**Why.** It's a live view over the exact queues the worker already uses, is
mentioned by name in the assignment as an acceptable choice, and requires no
additional service or database — it reads directly from Redis. Admin-gating
it is a small addition beyond the bare requirement ("expose a live
dashboard") but a reasonable one, since an ungated `/admin/queues` route
would be a real information leak in anything resembling a production
system.

**Alternatives considered.** A hand-rolled queue-status endpoint/page was
considered and rejected as reinventing something Bull Board already does
well, for no benefit.

**Trade-offs.** None significant.

---

## ADR-015: Next.js + Tailwind for frontend

**Status:** Accepted

**Context.** The assignment allows React.js or Next.js, and Tailwind or any
modern CSS library.

**Decision.** Next.js (App Router) + Tailwind + TypeScript.

**Why.** App Router's file-based routing maps directly onto the small,
fixed route set this app needs (`/login`, `/dashboard`,
`/dashboard?tab=sent`), and Next.js's built-in dev server and production
build reduce setup work relative to hand-assembling a React SPA's tooling
(bundler config, routing library) — time that matters in a 48-hour window.
Tailwind keeps styling close to the Figma's spacing/color values without a
separate CSS architecture to design.

**Alternatives considered.** A plain React SPA (Vite) was viable and would
have satisfied the requirement equally; it wasn't chosen for any correctness
reason, only because Next.js's conventions cost less setup time for this
specific route shape.

**Trade-offs.** Slightly more framework surface (App Router conventions,
server vs. client components) than a bare SPA, in exchange for less
boilerplate. A net simplification for this project's size.

---

## ADR-016: Docker Compose for local infrastructure

**Status:** Accepted

**Context.** The assignment marks Docker as recommended, not mandatory, for
Redis and the database.

**Decision.** Docker Compose for Postgres, Redis, and Elasticsearch; the
API, worker, and frontend processes run directly (not containerized) for
faster local iteration.

**Why.** Three infrastructure services with specific version/extension
requirements (Redis with AOF, a specific Postgres version, a single-node
Elasticsearch) are exactly what Compose is good at making reproducible with
one command, which matters for a grader who needs to stand this up quickly.
Not containerizing the application processes themselves keeps the
inner dev loop (edit → restart worker → observe) fast, which matters more
during a time-boxed build than it does for the final handoff.

**Alternatives considered.** Installing Postgres/Redis/Elasticsearch
natively was rejected as a worse grading experience — it would require the
reviewer to have specific versions of three services already installed,
rather than running one `docker compose up`.

**Trade-offs.** The application processes aren't containerized, so "run the
whole thing in Docker" isn't a single command — the README instead documents
`docker compose up` for infra plus `npm run dev` for each app process. Noted
explicitly in the README so this isn't a surprise during grading.

---

## ADR-017: At-most-once normal processing + explicit handling of the SMTP/DB ambiguous crash window

**Status:** Accepted

**Context.** "Emails are not duplicated" and "maintain idempotency" are
explicit hard requirements. It would be easy — and dishonest — to describe
the system as providing exactly-once delivery outright. It doesn't, and no
system built on an SMTP handoff plus a separate database write reasonably
can, because sending the email and recording that it was sent are two
different operations against two different systems, with no distributed
transaction between them.

**Decision.** State the actual guarantee precisely: the system is
**at-most-once under normal operation** (every mechanism in ADR-003 through
ADR-005 exists to prevent a duplicate send under ordinary retries, restarts,
and concurrent workers), and it has exactly one detectable, un-eliminated
window — a crash between the SMTP call succeeding and the Postgres `sent`
write committing — which is **detected and surfaced**, not silently papered
over or falsely claimed away.

**Why this is the honest position, not merely a cautious one.** Consider
what "exactly-once" would actually require here: either the SMTP send and
the database write happen atomically (impossible — they're different
systems with no shared transaction), or the system has a way to ask Ethereal
after the fact "did you actually deliver this message" and get a reliable
answer before deciding whether to resend (Ethereal, being a fake SMTP
sink for testing, doesn't provide a delivery-confirmation query most real
providers don't reliably provide either). Absent either of those, any claim
of guaranteed exactly-once delivery would be describing a system that
doesn't exist. What's implementable, and is implemented, is: make the
ambiguous window as narrow as possible (write the `message_id` immediately
after the SMTP call returns, then write the status update right after), and
when reconciliation finds a row stuck in `processing`, use the presence or
absence of `message_id` to distinguish "probably never sent, safe to retry"
from "possibly already sent, needs review" rather than guessing in the
direction of a duplicate send.

**Alternatives considered.**

- **Claim exactly-once and move on.** Rejected as false. It would look
  better in a README for about as long as it took a reviewer to ask "what
  happens if the process dies right here" — a question the design has to
  survive, not just the happy path.
- **Always resend on any ambiguous `processing` row.** Rejected: this
  guarantees the row eventually reaches `sent`, but at the cost of a
  genuine risk of a real duplicate email reaching a real recipient in the
  cases where the first send did succeed — a worse outcome than leaving an
  ambiguous row flagged for review, given the assignment's explicit "not
  duplicated" requirement.
- **Never resend an ambiguous `processing` row (mark it `failed` and stop).**
  Rejected: this guarantees no duplicate, but at the cost of silently
  dropping emails that were in fact never sent (the far more common case,
  since the crash window is narrow) — trading a rare risk for a common one
  in the wrong direction.

**Trade-offs.** An ambiguous row requires a human (or a follow-up automated
process, out of scope for this assignment) to resolve by checking Ethereal's
own sent log for that message, rather than resolving itself automatically.
This is accepted as strictly better than either alternative above: it's the
one option that doesn't quietly convert a rare failure into either a
duplicate send or a silent loss.

**Implementation implications (precision fix, Phase 4).** The `message_id`
write and the `status = 'sent'` write are **two separate, sequential SQL
statements** — not one combined write. This was tightened during Phase 4
after reviewing the actual worker code: an earlier implementation wrote
both fields in a single `UPDATE`, which is more "atomic-looking" but is
actually the *wrong* atomicity for this mechanism. A single combined write
means Postgres's own guarantee — a statement either fully commits or not at
all — collapses this ADR's two crash outcomes into one: `message_id` would
only ever be observed as *absent* after a crash, never as *present with
`status` still `processing`*, silently making the "possibly already sent"
branch of the reconciliation logic above unreachable in real operation
(defeating the reason this ADR calls for storing `message_id` separately at
all). Splitting the write into two sequential statements is what makes the
ambiguous window a real, narrow, detectable state rather than dead code.
This does not change the decision above — the guarantee is still
at-most-once, ambiguous rows are still surfaced rather than resolved
automatically — it corrects how narrowly and correctly that guarantee is
actually realized in code.

---

## ADR-018: PostgreSQL-backed `idempotency_keys` table for API idempotency

**Status:** Accepted

**Context.** `architecture.md`'s Idempotency section describes `POST
/campaigns` storing "a mapping from that key to the resulting `campaignId`
and response body," but the six-table data model from Phase 2 had no table
for this, and Redis's three documented uses (BullMQ job storage, hourly rate
counters, the per-sender min-delay lock) didn't include it either. This gap
was identified during pre-implementation review and had to be closed before
Phase 2's schema could be considered final.

**Decision.** Add an `idempotency_keys` table in PostgreSQL:

```text
id               primary key
key              the client-supplied Idempotency-Key header value
user_id          the authenticated user who made the request
campaign_id      the campaign that resulted from the original request
response_body    enough data to reproduce the original response verbatim
created_at
```

with a **unique constraint on `(user_id, key)`** — the key is scoped to the
authenticated user, not global. Redis is explicitly **not** used as the
authoritative store for this.

**Rationale.** ADR-001 already establishes PostgreSQL as the sole source of
truth for durable application state; API idempotency for `POST /campaigns`
is correctness-critical (it is what stops a flaky-network retry from
double-scheduling an entire recipient list, per Phase 4 of `plan.md`) and
must survive both a Redis data loss event and an API process restart.
Redis's documented role in this system (see the Redis entry in
architecture.md's Component responsibilities) is deliberately narrow —
job timing and two specific rate-limit mechanics, both of which ADR-007
already accepts as tolerant of occasional Redis data loss (a degraded
window, not a correctness break). Extending Redis to a fourth,
correctness-critical use would blur that separation and would mean a rare
Redis failure could turn into an actual duplicate campaign rather than a
merely-late rate-limit reset.

**Alternatives considered.**

- **Redis `SET NX` with a TTL, keyed on the Idempotency-Key.** Rejected:
  this ties a correctness guarantee ("no duplicate campaign") to Redis's
  durability, which is exactly the dependency ADR-007 deliberately avoided
  for a less critical piece of state (the hourly counter). Losing this key
  wouldn't just blur a rate window — it would allow an actual duplicate
  campaign to be created from a retried request, which is one of the
  assignment's explicit hard requirements.
- **No persistent store; an in-memory map on the API process.** Rejected
  outright — fails the explicit API-restart requirement (Phase 4 of
  `plan.md`) as soon as the process restarts between the original request
  and its retry.

**Trade-offs / consequences.** One extra indexed lookup (`(user_id, key)`)
and, on a cache miss, one extra row insert per `POST /campaigns` call.
Accepted without reservation: campaign creation is not a hot, high-frequency
path (unlike the per-send rate-limit check), so the added cost is
negligible relative to the correctness it buys.

**Implementation implications.** The `(user_id, key)` uniqueness is enforced
at the database level, not just checked in application code, so a race
between two concurrent retries of the same request cannot both "win." The
lookup happens before the campaign/emails insert transaction begins; on a
hit **that matches the original request** (see below), the stored
`response_body` is returned as-is and no new campaign, email rows, or
BullMQ jobs are created. This table is part of the Phase 2 schema, alongside
the original six tables.

**Idempotent-replay verification (Phase 4).** This ADR's original wording
— "on a hit, the stored `response_body` is returned as-is" — assumed every
retry with a matching `(user_id, key)` is a legitimate retry of the exact
same request. Phase 4 had to make that concrete: what happens if the same
user reuses a key with genuinely different request data (a different
subject, a different recipient list)? Silently replaying the old response
would be misleading (the caller would be told their *new* request
succeeded, when what actually ran was the *old* one); silently creating a
second campaign would violate the whole point of this table. The
implemented behavior: on a hit, the retry's fields (`senderId`, `subject`,
`body`, the recipient set, and any explicitly-provided
`delayBetweenEmailsMs`/`hourlyLimit`) are compared against the campaign
that `idempotency_keys.campaign_id` actually points to. A match returns the
stored response (`200`). A mismatch returns `409
IDEMPOTENCY_KEY_CONFLICT` and creates nothing — deterministic, safe, and
never a silent duplicate in either direction. `start_at` is deliberately
excluded from the comparison: when omitted it defaults to "now" on every
call, so two legitimate retries a few hundred milliseconds apart would
otherwise spuriously conflict on that field alone.

The comparison is made against the **persisted campaign row itself**
(joined through `idempotency_keys.campaign_id`), not against a separate
stored request fingerprint. A dedicated fingerprint/hash column was
considered and rejected: the campaign row already *is* the ground truth of
what the original request produced, so comparing against it directly
gets the same correctness without a schema change — consistent with Phase
4's instruction to prefer the existing schema over adding to it unless
genuinely necessary.

---

## ADR-019: Explicit single-sender selection per campaign

**Status:** Accepted

**Context.** Every `emails` row requires a `sender_id`, and "multiple
senders don't interfere with each other" is an explicit graded requirement
(see `plan.md`'s Phase 12 test cases), but neither the documented `POST
/campaigns` payload nor the compose-modal field list (architecture.md's
Frontend architecture section) specified how a sender gets chosen for a
campaign, and there was no sender-creation endpoint at all. This left an
implicit choice — silently picking a sender on the backend, or omitting
sender selection from the UI entirely — that would have been made without
review.

**Decision.** A campaign uses exactly **one** sender, explicitly selected by
the user at creation time:

- `POST /campaigns` requires a `senderId` field in the request body.
- The frontend compose flow presents a sender selector, populated from
  `GET /senders`, that the user must choose from before scheduling.
- The API validates that the selected sender belongs to the authenticated
  user before creating anything.
- Every email row created for that campaign inherits that same `sender_id`.
- No `POST /senders` endpoint is added. Sender records continue to be
  created via the Phase 2 seed/development mechanism, as already documented.
- The backend never silently selects a sender on the user's behalf when one
  hasn't been specified — a missing `senderId` is a validation error, not a
  default.

**Rationale.** One sender per campaign matches how real email campaigns
work (a batch goes out from one identity) and keeps ADR-003's per-recipient-
job reasoning intact — that ADR's justification for per-recipient
`scheduled_at` divergence is about rate-limit overflow (ADR-008), not about
different recipients within one campaign using different senders. Making
the selection explicit and user-driven (rather than an implicit default)
is what makes "multiple senders" an actual, demonstrable product behavior
during grading, rather than something only visible by inspecting seed data
directly in the database.

**Alternatives considered.**

- **Auto-assign the user's first/default sender silently.** Rejected: hides
  a real choice from the user, and makes multi-sender behavior untestable
  through the actual UI being graded — a reviewer clicking through the
  compose flow would never see it happen.
- **Round-robin / distribute recipients across all of a user's senders
  within one campaign.** Rejected: nothing in the assignment asks for this;
  it would complicate the `addBulk`/transaction step in the scheduling
  architecture for no graded benefit, and it would make a single campaign's
  rate-limit behavior span multiple Redis keys and multiple hourly windows
  simultaneously, complicating both the demo and the order-preservation
  logic from ADR-008.
- **Add `POST /senders` now.** Rejected for this assignment: no current
  requirement needs user-created senders beyond what seeding already
  provides; this can be added later without conflicting with this decision.

**Trade-offs / consequences.** The compose flow now requires at least one
sender to already exist (satisfied by the Phase 2 seed script) before a
campaign can be created, and the frontend needs one additional `GET
/senders` call to populate the selector before the compose modal is usable.

**Implementation implications.** The `campaigns` table gains a `sender_id`
column (foreign key to `senders`), set once at creation from the validated
request field. The same database transaction that inserts the campaign and
its email rows (per the Scheduling architecture section) copies
`campaigns.sender_id` into every `emails.sender_id` — there is no path by
which an email row's sender can diverge from its campaign's sender.
`POST /campaigns` rejects the request (before any row is written) if the
supplied `senderId` does not belong to the authenticated user.

---

## ADR-020: `rate_windows` is a durable audit table updated on successful send; Redis remains the sole live enforcement authority

**Status:** Accepted

**Context.** ADR-007 calls `rate_windows` a "durable audit trail," but
neither `architecture.md` nor this document specified when or how it gets
written — leaving open whether it's a dual-write alongside the Redis
`INCR`, or something derived lazily from `emails` with no dedicated write
path at all. This had to be settled before Phase 5 (rate limiting) and
Phase 2 (schema) could be considered final.

**Decision.** `rate_windows` stays as its own PostgreSQL table — it is not
removed and not replaced by a query derived from `emails`. On a
**successful send** (after the SMTP call and the `emails` status write to
`sent` both succeed), the worker creates or increments the `rate_windows`
row for `(sender_id, window_start)` as part of recording that send's
durable outcome. This write is strictly downstream of, and never
participates in, the Redis Lua check from ADR-007: Redis remains the sole
live enforcement mechanism, and nothing about the `rate_windows` write path
is allowed to gate, delay, or re-decide whether a send was permitted. A
failure or lag in this write is never treated as license to allow — or as a
reason to block — additional sends.

**Rationale.** PostgreSQL already records every other durable outcome of a
send (`status`, `message_id`, `sent_at`, per the Idempotency section of
`architecture.md`), so recording the audit count in the same store, at the
same point in the same code path, keeps "what actually happened" queryable
from one place without depending on Redis's TTL'd counter still existing
later. Keeping Redis as the sole enforcement authority preserves ADR-007's
atomicity guarantee intact: introducing PostgreSQL into the enforcement
decision itself would reopen exactly the check-then-act race ADR-007's Lua
script exists to close, since PostgreSQL has no equivalent single-round-trip
atomic increment against the same key Redis uses for that check.

**Alternatives considered.**

- **Write `rate_windows` synchronously inside the same critical section as
  the Redis increment.** Rejected: Postgres and Redis cannot share one
  atomic transaction, so this only moves the drift risk earlier without
  eliminating it, while adding Postgres latency to the hot per-send
  enforcement path that ADR-007 specifically optimized to be Redis-only.
- **Derive `rate_windows` on demand by aggregating `emails` instead of
  maintaining a written table.** Rejected per this decision: `rate_windows`
  is to be kept and maintained as its own durable write, not replaced by a
  derived query — consistent with ADR-007's original framing of it as an
  audit table inspectable directly, independent of how `emails` happens to
  be indexed or queried.

**Trade-offs / consequences.** `rate_windows` can lag, or — on a crash
between the Redis increment and the Postgres write — briefly under-count,
relative to what Redis actually enforced in a given window. This is
accepted because `rate_windows` is documented as audit information, not
enforcement: a gap here changes what the audit table shows, never what a
sender is actually allowed to send next. The existing boot-time
reconciliation pass (architecture.md's Persistence and restart recovery
section) already treats stuck/ambiguous send outcomes as a case for review
rather than a count to silently correct, and that same posture extends to
`rate_windows`.

**Implementation implications.** The `rate_windows` write happens in the
same worker code path as the `sent` status write, immediately after the
SMTP call succeeds, as an upsert keyed on the table's existing unique
`(sender_id, window_start)` constraint. A failure to write `rate_windows` is
logged and does **not** roll back the `sent` status write, does not trigger
a retry of the send, and has no effect on the Redis counter or any
subsequent Lua check.

---

## ADR-021: Per-campaign start time and delay-between-emails, layered over the sender-wide minimum-delay floor

**Status:** Accepted

**Context.** The Figma compose UI's "start time" and "delay between emails"
controls (architecture.md's Frontend architecture / Compose modal section)
were originally documented as editable fields whose defaults mirror the
global `MIN_DELAY_MS` environment value, but with no dedicated persisted
campaign field and no enforcement path beyond the existing per-sender Redis
lock from ADR-006. On review, these are functional requirements from the
assignment's Figma spec, not decorative fields — a campaign creator's
explicit choice of delay must actually change when that campaign's emails
are attempted, not merely display a number the system silently ignores.
This was a real gap between the documented frontend behavior (editable,
implicitly submitted per campaign) and the documented enforcement mechanism
(global, per-sender only).

**Decision.**

- `campaigns` gains two new **required, non-null** columns: `start_at` (the
  earliest time any email in the campaign may be attempted) and
  `delay_between_emails_ms` (the minimum requested spacing between attempts
  for emails in that campaign).
- At campaign creation, if the user does not customize these values in the
  compose UI, they default to *now* (`start_at`) and the configured
  `MIN_DELAY_MS` environment value (`delay_between_emails_ms`) — but the
  **resolved value is written to the row**, not left to fall back to the
  live environment variable on every future read. A campaign's behavior is
  fully determined by its own row from that point on, consistent with
  architecture.md's governing principle that the row is what actually says
  what should happen.
- Each email's initial `scheduled_at` is computed from the campaign's
  `start_at` plus an offset derived from `delay_between_emails_ms` and the
  email's ordinal position within the campaign — the same order-preserving
  offset logic ADR-008 already uses for rescheduling overflow, applied here
  as the *initial* placement rather than only as a reschedule.
- The existing sender-level Redis minimum-delay lock (ADR-006) is retained
  **exactly as-is, unmodified**, as a sender-wide safety floor across every
  campaign for that sender. It is not replaced, and it does not become
  campaign-scoped.
- The effective minimum spacing actually realized for any email is:

  ```text
  actual spacing >= max(campaign.delay_between_emails_ms,
                         sender's MIN_DELAY_MS-derived lock duration)
  ```

  A campaign can request a *larger* effective spacing than the sender floor
  (by configuring a bigger `delay_between_emails_ms`), but can never make it
  *smaller* — the sender lock's own `SET NX PX <MIN_DELAY_MS>` behavior
  (ADR-006) is untouched, so if a campaign's configured delay is smaller
  than what the sender lock enforces, the lock's existing reject-and-
  reschedule path still fires and simply widens the realized spacing beyond
  what the campaign alone requested.

**Rationale.** This is a direct consequence of treating the compose UI's
delay control as functional rather than decorative, while preserving the
sender-wide Redis lock exactly because a sender's real sending capacity is
a property of the *sender* (its Ethereal identity — in a real system, the
mail provider's own limits), not of any single campaign. Two campaigns
sharing a sender must not be able to combine to send faster than the sender
can safely handle merely because each stayed under its own configured
delay. Layering campaign delay over sender delay — rather than one
replacing the other — is the only structure that satisfies both
constraints at once.

**Alternatives considered.**

- **Campaign delay replaces sender delay entirely** (drop the per-sender
  lock; key everything by campaign instead). Rejected: reopens exactly the
  cross-campaign problem ADR-006 exists to prevent, now at the campaign
  boundary instead of the worker-instance boundary.
- **Campaign delay as a purely advisory/display value**, with actual
  spacing still governed only by the sender lock. Rejected: this is what
  created the gap in the first place — the Figma control has to actually
  change behavior.
- **Store `delay_between_emails_ms` as nullable, falling back to reading
  the live `MIN_DELAY_MS` env var at send time when null.** Rejected in
  favor of always resolving and persisting a concrete value at creation
  time: a nullable-with-fallback design would let an already-created
  campaign's timing silently change if the env var is edited afterward,
  which contradicts "the row is what actually says what should happen."

**Consequences / trade-offs.** Slightly more write-time computation
(resolving defaults and initial per-email `scheduled_at` offsets at
creation) and one more layer to reason about when debugging spacing (was a
given reschedule caused by the campaign's delay or the sender lock
rejecting it?). Mitigated by both being independently inspectable: the
sender lock's own Redis key, and the campaign's stored
`delay_between_emails_ms`, are both directly queryable, so the cause of any
given reschedule is always attributable to one or the other.

**Implementation implications.** `campaigns.start_at` and
`campaigns.delay_between_emails_ms` are `NOT NULL`, resolved (from the
user's input or the env-var defaults) before the campaign row is inserted,
in the same request-handling code path that already validates `senderId`
(ADR-019) and checks `Idempotency-Key` (ADR-018). The sender-level Redis
lock mechanism (`lock:sender:{senderId}`, `SET NX PX <MIN_DELAY_MS>`) is
unchanged by this ADR. No new Redis key is introduced here — only ADR-022
introduces new Redis keys, for the hourly limit.

---

## ADR-022: Dual-counter hourly rate limiting — per-campaign quota enforced alongside a per-sender safety quota

**Status:** Accepted

**Context.** Same root cause as ADR-021: the compose UI's "hourly limit"
control was documented as editable, defaulting to
`MAX_EMAILS_PER_HOUR_PER_SENDER`, but the only enforcement path documented
(ADR-007, ADR-009) was a single Redis Lua counter keyed purely per sender,
with no campaign dimension at all. Making the hourly-limit control
functional requires a real per-campaign enforcement path, while the
existing per-sender enforcement must be retained so that no combination of
campaigns on one sender can exceed the sender's own safety ceiling — the
concern illustrated directly by this decision's worked example: a sender
with two campaigns capped at 50/hour and 100/hour respectively must still
never exceed the sender's own 200/hour safety limit, even though neither
campaign individually approaches it.

**Decision.**

- `campaigns` gains a required, non-null `hourly_limit` column, resolved at
  creation time from the user's input or the `MAX_EMAILS_PER_HOUR_PER_SENDER`
  default, and persisted — the same "resolve once, store the concrete
  value" reasoning as ADR-021, for the same reason (no live fallback to the
  env var after creation).
- **Two logically separate Redis counters** are checked for every send
  attempt, both via the atomic Lua check-and-increment pattern from
  ADR-007:
  - **Sender counter (unchanged from ADR-007):** `rate:{senderId}:{hourWindow}`,
    capped at the sender's safety ceiling
    (`MAX_EMAILS_PER_HOUR_PER_SENDER` — a fixed system default, **not**
    itself overridable per campaign, since it exists to bound the sender
    regardless of any campaign's own configuration).
  - **New campaign counter:** `rate:campaign:{campaignId}:{hourWindow}`,
    capped at that campaign's own `hourly_limit`.
- A send is permitted only if **both** checks grant a slot in the same
  attempt. This is implemented as one Lua script taking both keys and both
  limits as arguments, so both checks and both increments happen atomically
  together — never as two separate round-trips, which would reopen the
  exact race ADR-007 closed (two workers could each pass the sender check
  independently before either increments the campaign counter, or vice
  versa).
- If **either** counter is exhausted, the email is rescheduled — never
  dropped or failed — using the existing reschedule-not-drop mechanism
  (ADR-008), into the next window in which both counters have room, with
  the existing order-preservation offset logic applied per campaign.

**Rationale.** Checking both counters atomically in one script is what
makes "two campaigns on the same sender cannot jointly exceed the sender's
safety ceiling" actually true under concurrent workers, not merely true by
convention — the same property ADR-007 established for the single-counter
case, extended to two dimensions. Keeping the sender counter's cap fixed at
the environment default, and explicitly **not** campaign-configurable, is
what makes it a genuine safety ceiling rather than just another
user-adjustable number: it exists specifically to bound behavior regardless
of what any campaign creator sets for their own campaign. This is why
sender-wide protection is retained rather than superseded: the sender is
the actual shared, finite resource (one Ethereal identity, or in a real
system, one mail provider account with its own limits); campaigns are a
budget allocated *within* that resource, not a replacement for bounding it.

**Alternatives considered.**

- **A single counter per `(senderId, campaignId)` pair, with a separate
  aggregation step to enforce the sender-wide cap** (e.g. summing several
  Redis keys before deciding). Rejected: aggregating across campaigns at
  check time is not one atomic operation, reopening a check-then-act race
  across campaigns — the sender-wide cap must be its own atomically-checked
  counter, not something recomputed from parts.
- **Enforce only the campaign counter**, treating the sender counter as
  redundant once campaign limits exist. Rejected — explicitly ruled out:
  this would let any number of campaigns, each individually configured
  under the sender's cap, jointly exceed it (per this decision's worked
  example, two campaigns at 50/hour and 100/hour could jointly reach
  150/hour with no counter ever stopping them, and there is no bound at all
  once more campaigns are added).
- **Enforce only the sender counter**, treating the campaign's
  `hourly_limit` as advisory/display-only. Rejected for the same reason
  ADR-021 rejected the advisory-only alternative for delay: this is
  precisely the gap being closed.
- **Two sequential (non-atomic) Lua calls, one per counter.** Rejected: a
  call that is atomic *within itself* is not atomic *with respect to* a
  second, separate call — a job could pass the sender check, then before it
  checks the campaign counter, another job could exhaust either counter (or
  vice versa), reopening a smaller but real version of the exact race
  ADR-007's single script was designed to prevent.

**Consequences / trade-offs.** Every send attempt now costs one Lua script
touching two keys instead of one — marginally more Redis work per attempt,
negligible given the system's throughput is already capped in the
hundreds-per-hour range by design. Reschedule logic must determine which
counter(s) were exhausted and reschedule into a window where both have
room — mechanically the same reschedule-as-data approach from ADR-008, now
evaluated against two constraints instead of one. `rate_windows` (ADR-020)
remains a sender-scoped durable audit table; this ADR does not introduce a
parallel per-campaign audit table, since the campaign counter's purpose is
live enforcement, not reporting — a campaign's realized send history is
already fully reconstructable from `emails` rows filtered by `campaign_id`.

**Implementation implications.** The Lua script from ADR-007 is extended to
take two `KEYS`/limit pairs instead of one, granting a slot only if both
`current < limit` checks pass, incrementing both only in that case. The
sender-wide cap (`MAX_EMAILS_PER_HOUR_PER_SENDER`) is read from
environment/config exactly as before (ADR-009) and is never read from a
campaign row. The campaign's `hourly_limit` is read from the `campaigns` row
(via the email's `campaign_id`) at check time. No change to `rate_windows`'s
schema or write path from ADR-020.

---

## ADR-023: Temporary pre-OAuth development identity header (`X-Dev-User-Id`)

**Status:** Accepted — **explicitly temporary**. Superseded in full by
ADR-012's real session-cookie middleware once Phase 7 lands; this ADR
should be marked superseded at that point, not deleted.

**Context.** Phase 4 needed `POST /campaigns` to exist so the
`idempotency_keys` behavior from ADR-018 could actually be tested end to
end — and that endpoint needs to know *which user* is calling it, both to
validate sender ownership (ADR-019: a campaign's `senderId` must belong to
the caller) and to scope the idempotency key (ADR-018's `(user_id, key)`
uniqueness). ADR-012's real Google OAuth flow is explicitly a later phase
(Phase 7) and building it early, just to unblock this test, was out of
scope and would have meant implementing a large, unrelated feature ahead of
its planned order.

**Decision.** A single-purpose middleware
(`backend/src/middleware/devAuth.ts`) reads an `X-Dev-User-Id` header,
looks it up against the real `users` table (rejecting an unknown or
missing id with `401`), and attaches the result as `req.userId`. It is
applied to exactly one route, `POST /campaigns`. It is not a session: no
cookie, no token, no signature, no expiry — the caller states who they are
by id and is trusted outright.

**Why this is acceptable now, and why it must not be mistaken for the real
thing.** Nothing downstream treats this as a security boundary yet: there
is no production deployment in scope, no browser-facing session anywhere
in the system, and the only thing this header can do is impersonate a
`users.id` that must already exist in the seeded/dev database — there is no
sign-up path through it, no privilege it grants beyond "act as this already
-provisioned row." It exists solely to make ADR-018 and ADR-019's
already-approved, already-documented behaviors testable now rather than
leaving them theoretical until Phase 7.

**Alternatives considered.**

- **Build real Google OAuth now, out of order.** Rejected: explicitly
  Phase 7's scope; pulling it forward to unblock a Phase 4 test would have
  meant building and reviewing a large, unrelated feature (OAuth
  redirect/callback flow, ID token verification, session cookie issuance)
  under Phase 4's much narrower reliability mandate.
- **No identity at all — accept a plain `userId` field in the request
  body.** Rejected: this would make ADR-019's ownership check and
  ADR-018's per-user key scoping untestable in any meaningful way, since
  any caller could simply claim to be any user by writing a different id
  into the body — indistinguishable, in a test, from having no ownership
  check at all.
- **A fuller mock-session system** (e.g. a `/dev/login` route issuing a
  signed development cookie, mimicking the shape of the real session).
  Rejected as more machinery than the actual need — Phase 4 needs *a*
  caller identity to test against, not a second, parallel session
  implementation that would itself need to be built carefully and then
  torn out again at Phase 7.

**Trade-offs / consequences.** This is trivially spoofable — any caller can
claim to be any user id — and must never run in a real deployment. The
blast radius is deliberately minimized: it is confined to one file, named
and commented so it cannot be mistaken for production auth, and gates
exactly one route. It is expected to be **deleted outright**, not extended
or generalized, when Phase 7 replaces it.

**Implementation implications.** `backend/src/middleware/devAuth.ts` sets
`req.userId` after validating the header against a real `users` row;
`POST /campaigns` is the only consumer. `docs/architecture.md`'s API table
lists `POST /campaigns`'s Auth column as "session cookie" (the intended,
final design) with a note pointing here for the current, temporary reality.
When Phase 7 lands: this file is deleted, `POST /campaigns` (and every
other protected route added by then) switches to the real session
middleware, and this ADR is marked **Superseded by ADR-012** rather than
removed from the record.
