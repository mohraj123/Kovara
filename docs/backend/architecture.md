# Kovara backend — architecture

This page describes the **Kovara indexer** (`Backend/`), the Node/TypeScript service
that indexes Kovara Social contract events into PostgreSQL and serves a read-only
REST API over the result.

> **Source of truth.** Everything here was read from the code on `main`
> (verified at commit `2c42735c443e`). Where this page and a comment disagree, the
> code wins. The "Known gaps" section lists behaviour that is visible in the code
> but easy to assume otherwise.

> **Note on the root `README.md`.** The repository root README still describes an
> older `packages/sentinel` / `packages/api` / `packages/atlas` layout that does
> not exist in this tree. It is not a description of this backend. Use
> `Backend/README.md` and this directory for the backend.

## 1. Where the service sits

| Path | What it is |
| --- | --- |
| `Backend/` | The indexer + REST API (this document). Node 18+, TypeScript, Express 4, `pg`. |
| `Contract/`, `packages/contracts/` | Soroban smart contracts (Rust). The indexer consumes their events. |
| `apps/web/` | Next.js web client. |
| `apps/mobile/` | Expo/React Native client. |
| `packages/sdk/` | TypeScript SDK (`packages/sdk/src/client.ts`). |

The backend is a **single process** with two responsibilities:

1. stream Soroban contract events into PostgreSQL, and
2. serve a read-only REST API over the indexed data.

Runtime dependencies are deliberately small — `express`, `cors`,
`express-rate-limit`, `express-async-errors`, `pg` (`Backend/package.json`). There
is no ORM; SQL lives in `Backend/src/db.ts` and the `handlers/` modules.

## 2. Startup sequence

Entry point: `Backend/src/index.ts` (`main()`).

1. **Configuration** — `loadStartupConfig()` calls `loadConfig()`
   (`Backend/src/config.ts`) at module scope, before the pool is created.
   `DATABASE_URL` (must be `postgres://`/`postgresql://`) and `CONTRACT_ID` (a
   56-character `C…` StrKey, CRC16-checked) are required. `STELLAR_RPC_URL` and
   `START_LEDGER` are optional but validated when set. A `ConfigError` logs
   `config_invalid` and exits `1` with every problem listed together.
2. `configureAlerting()` wires the alert sinks (inert unless a sink is configured).
3. **Mode selection** — if both `REPLAY_START_LEDGER` and `REPLAY_END_LEDGER` are
   set, the process runs a replay of that inclusive ledger range and exits;
   otherwise it runs live streaming.
4. **Database init** — `runMigrations(pgPool)` →
   `ensureEventsTable()` → `ensurePostSearchIndex()`.
5. **HTTP server** — `createApp(db, { authMiddleware })` and `app.listen(HOST, PORT)`.
   The API is available immediately, even in replay mode.
6. **Streaming** — live mode calls `streamEvents(...)`; each event is dispatched
   through `processEvent(event, handleEvent)`.
7. **Shutdown** — `SIGTERM`/`SIGINT` abort the stream, close the HTTP server, and
   end the pool (`shuttingDown` guard prevents double cleanup).

## 3. Persistence

PostgreSQL accessed through a `pg.Pool` sized by `DB_POOL_*` (`Backend/src/config.ts`).
Migrations live in `Backend/migrations/*.sql` and are applied by
`runMigrations()` (`Backend/src/migrate.ts`):

- an `schema_version` table records applied versions;
- `pg_advisory_lock(7357192468)` serialises concurrent migrators;
- each file runs in its own transaction; a failing file is rolled back, logged as
  possible schema drift, and **skipped** rather than aborting startup.

Core tables (created by migrations and `ensureEventsTable`): `profiles`, `posts`,
`follows`, `tips`, `likes`, `pools`, `events`, `stream_state`, `schema_version`.

### Event processing state machine

`events` carries an explicit processing status so a persisted event is never
"present but unaccounted for":

| Status | Meaning |
| --- | --- |
| `new` | Persisted (`INSERT … ON CONFLICT (event_id) DO NOTHING`), side effects not applied. |
| `processing` | Claimed atomically by `claimEvent()` before dispatch, so concurrent/restarted workers cannot double-apply side effects. |
| `processed` | Handler succeeded (`markEventProcessed`). |
| `failed` | Handler raised (`markEventFailed`); error text and timestamps are retained for retry. |

Dead-letter bookkeeping: `attempts`, `error`, `processed_at`, `failed_at`,
`dead_lettered_at`. `EventStore` (`Backend/src/event-store.ts`) exposes
`saveCursor`/`loadCursor` (the `stream_state` key/value table),
`markProcessed`, `markFailed`, `deadLetter`, `listFailedEvents`, `requeueEvent`
and `retryFailedEvents`.

`recoverPendingEvents()` (in `index.ts`) replays every row whose status is not
`processed`, which is what makes restart-based recovery safe.

## 4. Event pipeline

```
Soroban RPC getEvents          (stream.ts)
  → validateEventsResult()     shape-check the provider response
  → normalizeRawEvent()        trim/validate fields (normalize.ts)
  → in-memory dedup ring       event.id, bounded cache (dedupCacheSize)
  → contract-ownership check   event.contractId === CONTRACT_ID
  → eventTypeFilter            optional FILTER_EVENTS allowlist
  → processEvent()             persist → claim → handler → mark processed/failed
  → handleEvent()              typed dispatch
```

The dispatch table in `handleEvent()` (`Backend/src/index.ts`) is keyed on
`event.topic[0]`:

| Topic key | Handler |
| --- | --- |
| `profile_set` | `handlers/profile.ts` → `handleProfileSet` |
| `post_created` | `handlers/post.ts` → `handlePostCreated` (receives `{ pgPool }`) |
| `post_deleted` | `handlers/post.ts` → `handlePostDeleted` |
| `like` | `handlers/like.ts` → `handleLike` |
| `follow` / `unfollow` | `handlers/follow.ts` → `handleFollow` / `handleUnfollow` |
| `tip` | `handlers/tip.ts` → `handleTip` |
| `pool_created` / `pool_deposit` / `pool_withdraw` | `handlers/pool.ts` |
| anything else | `logger.warn("unknown_event_type", …)` |

Handlers are written to be idempotent (upserts and unique constraints), so replay
does not duplicate data.

The on-chain event schema the indexer consumes is documented in
[`packages/contracts/contracts/linkora-contracts/EVENTS.md`](../../packages/contracts/contracts/linkora-contracts/EVENTS.md).

## 5. API layer

`createApp(db, options)` (`Backend/src/api/index.ts`) builds the Express app.
Middleware order:

1. `cors()` — currently permissive, no configured origin (see Known gaps).
2. `express.json()`.
3. Request timeout (`REQUEST_TIMEOUT_MS`, default 30s) → `503 REQUEST_TIMEOUT`.
4. Correlation ID middleware — reads `X-Correlation-Id`, generates one when
   missing, stores it on `req.correlationId`.
5. `GET /health` and `GET /version` (unversioned, no auth).
6. Rate limiter on the `/api` prefix when `ENABLE_RATE_LIMITING !== "false"`.
7. Routers mounted on an API router:
   - `/profiles`, `/posts`, `/follows`,
   - `POST /search/posts`, `GET /debug/snapshot`,
   - `/pools` only when `EXPERIMENTAL_FEATURES === "true"`.
8. API router mounted at `/api/v1` (canonical) and `/api` (legacy). Legacy
   responses get `Deprecation: true` and a `Link: </api/v1/…>; rel="successor-version"` header.
9. 404 catch-all, then the global error handler.

Request/response shapes and error codes are in
[`api-contracts.md`](./api-contracts.md). Shared response helpers live in
`Backend/src/api/response.ts`; shared TypeScript response types live in
`Backend/src/api/contracts.ts`.

The request-context middleware also binds the request ID for downstream async
work. JSON API error bodies with `error` and `code` include `requestId` when an
active request context exists; calls made without request context leave the body
unchanged. The same ID is echoed in `X-Request-Id` and the legacy
`X-Correlation-Id` response headers. Successful JSON responses are not modified.

### Feed ordering and the tie policy (issue #922)

Feed ranking (`Backend/src/feed/ranking.ts`) is pure and explainable: the same
candidates and the same clock always produce the same order. Three modes answer
different questions — `ranked` (weighted engagement + recency), `recent` (strict
reverse-chronological) and `trending` (engagement *rate* over a bounded window).

Every mode is given a **total order**, not just a score:

- Scores are rounded to six decimal places *before* comparison, so two posts
  that differ only below that precision are treated as tied rather than being
  ordered by floating-point noise.
- Ties are broken by **`id` descending** (`FEED_TIE_BREAK = "id_desc"`). Post ids
  are unique and monotonic, so this is stable across requests and independent of
  the order the rows came back from Postgres.
- Entries with no usable score (`-Infinity` — `recent` mode with no timestamp,
  trending outside the window) always sort after scored ones and are tied among
  themselves by the same `id` rule.
- Soft-deleted posts are dropped before ranking, not ranked last.

Tied timestamps are the case this exists for. Two posts written in the same
ledger second score identically, and without a trailing unique key Postgres is
free to return those rows in any order — so a client paging with `offset` sees
one row twice and never sees the other. The `id_desc` tie-break makes the order
independent of arrival order, which is what "stable results" means here. The
policy is echoed in every response as `ranking.tie_break`, so a client can see
why two equal-scoring posts came back in the order they did.

### Reward rule precedence (issue #975)

`assessSubmission` is a pure function: the same submission and verifications
always produce the same rewards, whatever order they arrive in. When rules
overlap, this is the order they apply:

1. **Submission state first.** A `rejected` or `pending` submission pays
   nothing and every vote on it is reported as `submission_not_verified`.
2. **Per verification**, the first matching rule wins and the vote is reported
   once: duplicate vote (the first recorded act per verifier stands) ->
   invalid verifier address -> self-verification -> non-approving verdict
   (recorded, unpaid) -> paid.
3. **Modifiers on the submitter's line** compose in a fixed order: base reward,
   then the corroboration multiplier, then the review hold. A flagged
   submission pays `base x corroboration x pendingReviewBps` and all of its
   accruals are `pending`.

"First recorded" is made well defined by `VerificationRecord.sequence`: when
every record has one they are evaluated in that order; otherwise the order
supplied is taken as the recorded order. Output is canonical (submitter line
first, then verifier lines by address; ignored votes by verifier), so input
order never changes the assessment.
### Database transactions and the activity-feed index (issues #970, #973)

`PostgresDatabase.withTransaction(fn)` runs a multi-step write on one dedicated
connection: `BEGIN`, the caller's statements, then `COMMIT`. Any failure,
including a failing `COMMIT`, triggers an explicit `ROLLBACK` and the original
error is rethrown, so no partial change survives. The client is always released
(destroyed if the rollback itself fails), and the shared cache epoch is bumped
only after a successful commit. Statements must use the client handed to `fn`.

The contributor activity feed (`PostgresActivityFeed.list`) unions
`submissions` (by `submitter`) and `verifications` (by `verifier`), then orders
by time. Migration `014_activity_feed_indexes.sql` gives each branch an index
matching its newest-first order, and the indexes `INCLUDE` the other selected
columns so a page can be answered by an index-only scan. Migrations are
discovered automatically from `Backend/migrations/*.sql` (there is no separate
registry), so the file is registered by existing in that directory; its
`schema_version` row is `014_activity_feed_indexes`. The query plan was not
measured when this change was made, so confirm it on real data with:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM submissions WHERE submitter = 'G…' ORDER BY submitted_at DESC, id LIMIT 20;
```
### Canonical event identity (issue #966)

Ingestion dedupes on `canonicalId`, not on the provider's raw `eventId`.
`canonicalizeEventId` strips surrounding whitespace and, for purely numeric ids
such as `0000012884905984-0000000001`, the leading zeros of each segment
(`12884905984-1`); other ids are lower-cased. The same on-chain event delivered
with a differently padded or cased id is therefore recognised as a duplicate
during replay, while genuinely different events keep distinct identities. The
original `eventId` is still carried for logs and storage.

### Event-store retention (issue #968)

`EventStore.purgeExpiredEvents()` deletes one batch of expired events per call.
Only `processed` rows are eligible, and only if they are older than
`retentionDays` (default 30) **and** outside the replay window, i.e. more than
`replayWindowLedgers` (default 10,000) ledgers behind the newest stored event.
`pending`, `failed` and `dead` rows are never deleted, so unfinished work and
dead-letter evidence survive, and the replay window keeps recent history
available for `replayLedgerRange`. Batches (default 1,000 rows) keep locks short;
repeat the call until it deletes fewer rows than the batch size. Nothing calls
it automatically yet: schedule it from the operator tooling of your choice.
### Ingestion checkpoints and envelope validation (issues #964, #965)

`LedgerIngestor.ingestRange(range, { process })` hands the accepted events of a
batch to `process`. `nextLedger` is only returned after `process` resolves for
the whole batch; if it throws, the batch's event ids are removed from the
seen-set (so the retry does not drop them as duplicates) and the error
propagates with no `nextLedger`, so the caller cannot checkpoint past
unprocessed events. Checkpoint persistence itself is the caller's job and must
happen after `ingestRange` returns.

Before normalization, the ingestor validates the event envelope in strict mode
(`normalizeStellarEvent(raw, { strict: true })`): a non-empty `contractId`,
`txHash`, a parseable `ledgerClosedAt`, a first topic that decodes to an event
name, and a string `value` when one is present. Events failing this check are
counted as `malformed` and never reach a handler. Lenient mode remains the
default for other callers.
### Retry classification (issue #961)

`classifyFailure` in `Backend/src/retry.ts` decides whether an error is worth
retrying. It is checked in this order:

| Signal | Retried (transient) | Not retried (permanent) |
| --- | --- | --- |
| Error `code` | Retryable SQLSTATEs (`40001`, `40P01`, `08xxx`, `53xxx`, `57P0x`, ...) and socket codes (`ECONNRESET`, `ETIMEDOUT`, ...) | Integrity class `23xxx`, `22P02`, `22007`, `22012` |
| HTTP status (`status`, `statusCode`, `response.status`) | 408, 425, 429, 500, 502, 503, 504 | Every other 4xx/5xx (400, 401, 403, 404, 409, 422, 501, ...) |
| Message text | Timeout, connection reset/refused, "temporarily unavailable", rate limit, ... | "malformed", "invalid", "constraint", "unauthorized", "not found", ... (checked first) |
| Anything else | | Unclassified errors are permanent |

A permanent failure fails on the first attempt without any backoff and is routed
to the dead-letter path with the classification reason in the log.
### Wallet signature replay protection (issue #955)

When a `NonceRegistry` is supplied, `walletSignatureMiddleware` records each
proof's nonce after the signature verifies and rejects a second use with
`401 WALLET_NONCE_REUSED`. Nonces are stored as `<address>:<nonce>` so they are
scoped to the signing wallet, and expire when the proof's validity window ends.
A registry that implements `tryAdd` is used for an atomic check-and-set, so two
concurrent copies of the same proof cannot both pass; `has` + `add` is only a
fallback. If the registry fails, the request is refused (`503`), never allowed.
`InMemoryNonceRegistry` is single-replica only; multi-replica deployments need a
shared registry with the same atomic `tryAdd` semantics.

### Address rate-limit key cardinality (issue #957)

The per-address limiter keys its counters on the Stellar address found in the
request. Because any well-formed address is a valid key, an attacker could
otherwise create unbounded buckets. `BoundedAddressStore` keeps at most
`ADDRESS_RATE_LIMIT_MAX_KEYS` buckets: each expires when its window ends, and if
the cap is still exceeded, expired buckets are removed first and then the least
recently used. A bucket that is being used is moved to the most-recent end on
every hit, so cleanup does not reset the limit of an active address; only idle
addresses are evicted. The store is per-process and in memory.

### Profile event replay safety (issue #924)

`ProfileSet` states a desired **end state** — "this account's profile *is* this"
— not a transition that may only happen once. The chain redelivers events after
a crash, inside a replay window, or over an at-least-once transport, so applying
N deliveries must leave exactly the profile that applying one would.

`handleProfileSet` guarantees that with two rules:

1. **Strictly-newer ledger only.** An event whose ledger is not greater than the
   stored `updated_ledger` is ignored. That covers both halves of a replay: a
   redelivery of the event already applied (`ledger ===`) and a replayed older
   one (`ledger <`, the out-of-order case first raised in issue #927). The
   newest *valid* state therefore always wins, and a duplicate can never
   overwrite it — including a duplicate that carries a different username.
2. **Canonical lookup key.** `event.user` is trimmed and folded to upper case
   before the read *and* the write, so an event carrying `gabc…` resolves to the
   row written as `GABC…` (issue #925). Without this a replayed event can miss
   the existing row, take the "no profile yet" branch and open a second profile
   for the same account.

A `ProfileSet` with no stored profile is applied unconditionally — the first
event is always the current state.

### Repeated-unfollow semantics (issue #931)

An `Unfollow` event states a desired end state — "follower does not follow
followee" — not a transition that may only happen once, so every delivery is
judged against the graph as it is at that moment:

- the relationship exists → it is deleted (`DELETE FROM follows WHERE follower =
  $1 AND followee = $2`), and a racing duplicate affects zero rows;
- the relationship is already gone → the handler logs the replay and returns
  without issuing a write.

No replay, ordering or repetition changes the outcome: N deliveries of the same
`Unfollow` leave exactly the same relationship count as the first one, and
unrelated edges in the graph are never touched. `handleUnfollow` therefore
never fails on a repeat — a missing edge is a no-op, while a malformed event
(missing `follower`/`followee`) still throws before any database call.

### Like-count derivation (issues #932, #933)

`handleLike` derives `posts.like_count` from the rows themselves instead of
appending `+ 1`:

```sql
UPDATE posts
SET like_count = (SELECT COUNT(*) FROM likes WHERE post_id = $1)
WHERE id = $1 AND deleted_at IS NULL
```

The recount runs in the same `SERIALIZABLE` transaction as the insert, and the
insert itself is guarded by the `(post_id, user_address)` unique constraint, so
a redelivered or concurrently retried like can never move the count twice —
after any number of replays the count equals the number of like rows. Before
inserting anything the handler reads the post row and separates the two
rejection cases: a **missing** post and a **soft-deleted** post (`deleted_at`
set) each commit and return without creating a like row or touching the count.

## 6. Observability

- **Logging** (`Backend/src/logger.ts`) — `StructuredLogger` writes one JSON line
  per event (`ts`, `level`, `logger`, `msg`, plus bound fields). It deduplicates
  identical `level:message` pairs within a 60s window, redacts Stellar addresses
  and long opaque payloads, and records error/warn counts accessible via
  `getErrorMetrics()`.
- **Alerting** (`Backend/src/alerting.ts`) — `AlertManager` delivers to a
  `SentrySink` (built from `SENTRY_DSN`) and/or a `WebhookSink`
  (`ALERT_WEBHOOK_URL`). It applies a severity threshold, an ignore list, a
  per-fingerprint dedup window, a per-window delivery budget, and a sampling
  rate. `installLoggerAlerting()` routes `logger.error` into it. Alerting is
  completely inert until a sink is configured.
- **Endpoints** — `GET /health` returns `{ status, uptime, db }` where `db` is
  `ok` or `unavailable`; `GET /version` returns
  `{ version, git_commit, build_time, node_version }`.

## 7. Known gaps (verified)

These are real, observable in the code, and worth knowing before operating the service:

- **`Backend/src/stream.ts` does not parse.** The file is missing a closing brace
  (a stray `while (!signal.aborted) {` at the top of the stream loop), so
  `tsc`/`ts-jest` cannot compile it. The live streaming and replay paths cannot be
  built as committed.
- **Migration prefix collisions.** `007_*`, `008_*` and `014_*` each have several
  files. `runMigrations` now records every file by its full name, so none of them
  is skipped, but they still apply in filename order; see the runbook's
  Migrations section.
- **Auth middleware is not applied.** `index.ts` builds a Bearer/`API_SECRET`
  guard when `ENABLE_AUTH_MIDDLEWARE=true` and passes it via `createApp`'s
  `options`, but `createApp` resolves it into a variable and never calls
  `app.use(...)`. Requests are not authenticated.
- **Rate-limit env vars are not wired.** The limiter reads the module-level
  `rateLimitWindowMs`/`rateLimitMax` (defaults 60000/100, changeable only via the
  exported `setRateLimit()`, which tests call). `RATE_LIMIT_WINDOW_MS` /
  `RATE_LIMIT_MAX` are parsed but unused. `addressRateLimiter` is imported but not
  mounted.
- **`CORS_ORIGIN` is not read.** `app.use(cors())` is called with no options, so
  all origins are allowed regardless of the environment.
- **Unmounted routers.** `routes/regions.ts`, `routes/categories.ts` and
  `routes/verification-votes.ts` exist but are not mounted in `createApp`.
- **Experimental flag mismatch.** `index.ts` parses `ENABLE_EXPERIMENTAL_ROUTES`
  but never uses it; the pools router is actually gated on `EXPERIMENTAL_FEATURES`
  (which is what `Backend/README.md` and `.env.example` document).
- **Event topic convention.** `handleEvent` switches on `topic[0]`, while
  `EVENTS.md` defines topics as `(ContractName, EventName, Version)` with
  `topic[0] == "Kovara"`. Confirm which contract/ABI is deployed before relying on
  the dispatch keys.
- **Response envelope is inconsistent.** `api/response.ts` defines a
  `{ success, data, timestamp }` envelope, but most routes return bare resource
  objects and route-level errors return `{ error, code }` without `success`/
  `timestamp`. Only the 404 catch-all and the global error handler use the shared
  helpers.

### Follow pagination cursor behavior (issue #929)

The follows endpoints implement keyset pagination via the `cursor` query
parameter (an opaque Stellar address). When `cursor` is provided, the router
calls `db.getFollowersAfter(address, cursor, limit)` or
`db.getFollowingAfter(address, cursor, limit)`, and the implementation selects
the next `limit` addresses strictly after `cursor` using lexicographic ordering
on the address string (`follower > $2` / `followee > $2` with `ORDER BY ...`).
The `total` remains the global count for the relationship direction. Responses
set `next_offset` and `prev_offset` to `null` under cursor mode to reflect the
keyset model (clients advance by re-supplying the last returned address as the
next cursor). A cursor longer than the configured bound is rejected by
`parseCursor` as `INVALID_CURSOR`.
