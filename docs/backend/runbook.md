# Kovara backend — operational runbook

Day-two procedures for the indexer + REST API in `Backend/`. Commands are the ones
the repository actually provides (`Backend/package.json`, `Backend/Makefile`,
`Backend/Dockerfile`, `Backend/docker-compose.yml`). Anything the repo does not
support is called out explicitly rather than invented.

Read [`architecture.md`](./architecture.md) first for the runtime model. The
"Known gaps" section there matters operationally — in particular, `stream.ts`
does not currently compile and `auth middleware` is not applied.

## 1. Prerequisites

| Requirement | Source |
| --- | --- |
| Node.js 18+ | `Backend/package.json` → `engines.node`; Dockerfile uses `node:18-alpine` |
| PostgreSQL 14+ | `Backend/README.md`; Compose uses `postgres:16-alpine` |
| A Soroban RPC endpoint | `STELLAR_RPC_URL`, default `https://soroban-testnet.stellar.org` |
| The deployed contract id | `CONTRACT_ID` (required, 56-char `C…` StrKey) |
| Docker + Compose (optional, recommended) | `Backend/docker-compose.yml` |

## 2. Configuration

Copy `Backend/.env.example` to `Backend/.env` and fill it in. Startup fails fast
with every configuration problem listed if a required value is missing.

### Required

| Variable | Validation |
| --- | --- |
| `DATABASE_URL` | `postgres://` or `postgresql://` URL. |
| `CONTRACT_ID` | 56-character `C…` StrKey, checksum-verified (`config.ts`). |

### Indexing

| Variable | Default | Purpose |
| --- | --- | --- |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint. |
| `START_LEDGER` | `0` | First ledger to stream from. |
| `POLL_INTERVAL_MS` | `5000` | Delay between stream polls. |
| `FILTER_EVENTS` | unset (all) | Comma-separated event types to index, e.g. `post_created,like`. |
| `RPC_FETCH_TIMEOUT_MS` | `15000` | Per-RPC-fetch timeout. |
| `REPLAY_START_LEDGER` / `REPLAY_END_LEDGER` | unset | Set **both** to run a replay instead of live streaming. |

### HTTP server

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind address. |
| `PORT` | `3000` | Bind port. |
| `TRUST_PROXY` | `0` | Express `trust proxy`; set only behind a trusted reverse proxy. |
| `REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout → `503 REQUEST_TIMEOUT`. |
| `ENABLE_RATE_LIMITING` | `true` | Set `false` to disable the `/api` limiter. |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `60000` / `100` | Parsed, but not wired to the limiter today (see architecture gaps). |
| `ADDRESS_RATE_LIMIT_WINDOW_MS` / `ADDRESS_RATE_LIMIT_MAX` | `60000` / `100` | Per-address window and request cap, applied through `setAddressRateLimit()` at startup; the middleware is not mounted today. Window must be an integer 1000–86400000, max an integer 1–1000000; anything else fails startup naming the variable, value and allowed range. |
| `ADDRESS_RATE_LIMIT_MAX_KEYS` | `10000` | Cap on distinct addresses tracked at once (integer 1–1000000). Expired buckets are dropped first, then least recently used, so active addresses keep their counts. |
| `ENABLE_AUTH_MIDDLEWARE` | `false` | Builds a Bearer guard, but it is not applied today (see architecture gaps). |
| `API_SECRET` | unset | Expected bearer token when the auth middleware is eventually applied. |
| `EXPERIMENTAL_FEATURES` | `false` | Set `true` to mount the `/pools` routes. |
| `ENABLE_EXPERIMENTAL_ROUTES` | `false` | Parsed but unused; does **not** enable pools. |
| `DEBUG_TOKEN` | unset | Required for `GET /api/v1/debug/snapshot`; unset → `503`. |
| `GIT_COMMIT` / `BUILD_TIME` | `unknown` | Surfaced by `GET /version`. |

### Response cache capacity

Each process keeps its response cache in memory. A `ResponseCache` instance holds
at most 1,000 entries by default; callers that construct one directly can set
`maxEntries` to a different non-negative safe integer (there is no environment
variable for this setting). When a new entry exceeds the cap, entries past their
full stale expiry are evicted first, then the oldest inserted entries are removed
until the cache is within capacity. This keeps still-eligible stale values ahead
of entries that can no longer be served. Capacity is per cache instance, not
shared across replicas.

### Reconciliation dry run (issue #976)

`dryRunReconciliation(store, runDate)` reports what a reconciliation would find
and what an operator would do about it, without changing anything: it reads the
source and aggregate totals and returns the discrepancies plus
`plannedCorrections` (`recompute_aggregate` for a missing, mismatched or
miscounted aggregate, `remove_aggregate` for an aggregate with no source). It
takes only the two read methods of the store, so it cannot claim the day's
lease, write discrepancy rows or complete a run, and a dry run does not use up
the day: the scheduled run still happens afterwards. The planned corrections are
advisory; the reconciliation job still never repairs data itself.

### Ingestion lag alerting (issue #977)

`IngestionLagMonitor.observe(chainHeadLedger, ingestedLedger)` raises an `error`
alert when the ingestion lag stays above the threshold for a sustained period.
A short spike only moves the monitor to `breaching`; the alert fires once the
lag has been above the threshold continuously for the sustain time, once per
episode. When the lag returns to the threshold or below, the episode ends, a
`warning` "recovered" event is recorded (below the default delivery threshold,
so it is logged but does not page), and a later breach starts a new timer.

| Variable | Default | Purpose |
| --- | --- | --- |
| `INGESTION_LAG_THRESHOLD_LEDGERS` | `100` | Lag, in ledgers, above which ingestion counts as behind (1–10,000,000). |
| `INGESTION_LAG_SUSTAIN_MS` | `300000` | How long the lag must stay above the threshold before alerting (0–86,400,000). |

Invalid values fall back to the defaults. The monitor only alerts when an alert
sink is configured (see Alerting above).
### Ingestion batch limit (issue #967)

`LedgerIngestor` handles at most `maxEventsPerBatch` raw events per
`ingestRange` call (default 1,000, third constructor argument). When a range
holds more, whole ledgers are processed up to the cap and the rest is deferred:
the result has `truncated: true`, the number of left-over payloads in `deferred`,
and `nextLedger` points at the first ledger that was not fully processed, so
the next call resumes from there with nothing skipped. A single ledger larger
than the cap is processed whole so ingestion always makes progress. Keep calling
`ingestRange` from `nextLedger` until `truncated` is `false`.

### Duplicate stream subscriptions (issue #969)

Only one `streamEvents` subscription runs per RPC URL and contract. Starting a
second one (for example a reconnect that began before the old loop noticed it
was dead) aborts the old stream, waits for it to stop, and then starts the new
one; the log line `stream_subscription_replaced` marks this. Each poll's abort
listener is also removed when the wait ends, so a long-lived stream does not
accumulate stale listeners. If you see `stream_subscription_replaced` often,
look for something restarting the stream on a timer.
### Abuse-detection cooldown decay (issue #959)

A client tripped by the abuse detector is blocked for a cooldown that starts at
`baseCooldownMs` (30s) and doubles with each repeat offence, up to
`maxCooldownMs` (15 min). Abuse signals expire: once a client has had no offence
for `offenseDecayMs` (default 10 minutes, measured from its last offence), its
offence count resets and the next detection starts again at the base cooldown.
Offences that keep arriving inside that interval keep escalating. To lift a block
immediately, use `AbuseDetector.unblock()`, which also clears the offence count.

### Retry backoff cap (issue #960)

Transient failures are retried with exponential backoff: `baseDelayMs` (300ms)
multiplied by `backoffMultiplier` (2) per failed attempt, never exceeding
`maxBackoffMs` (60s). With jitter on (the default) each delay is a random value
below that ceiling, so the cap holds on every attempt. Invalid options (negative,
`NaN` or infinite delays, a multiplier below 1) fall back to safe values instead
of producing a zero or unbounded wait. A call that succeeds returns immediately
and spends no backoff; the delay only applies between failed attempts.

### Tiered rate-limit boundaries (issue #958)

Tiered limits (`search` 30/min and `write` 20/min by default) are counted per
client and per tier. Behaviour at the edges:

- Exactly `max` requests in a window succeed; request `max + 1` returns
  `429` with `code: "RATE_LIMIT_TIER_EXCEEDED"`, the `tier`, `retry_after` (the
  window length in seconds) and an `X-RateLimit-Tier` header. Further requests
  keep returning `429` until the window ends.
- Tiers are independent: exhausting `search` does not affect `write`, and
  untiered reads (profiles, health) are never counted by either tier.
- Classification follows the operation: any `POST/PUT/PATCH/DELETE` is `write`,
  even to a search-shaped path such as `POST /search`.

### Database pool

| Variable | Default |
| --- | --- |
| `DB_POOL_MAX` | `10` |
| `DB_POOL_CONNECTION_TIMEOUT_MS` | `5000` |
| `DB_POOL_IDLE_TIMEOUT_MS` | `30000` |
| `DB_STATEMENT_TIMEOUT_MS` (legacy alias `QUERY_TIMEOUT_MS`) | `30000` |

Pool settings are validated at startup (issue #971). A bad value stops the
process with a `ConfigError` that lists **every** invalid pool setting at once,
names the variable that was set (including legacy aliases such as
`DATABASE_POOL_MAX` or `QUERY_TIMEOUT_MS`), the accepted range and the default.
`DB_POOL_MAX` must be a whole number from 1 to 100; the three timeouts must be a
whole number of milliseconds from 0 to 600000, where `0` means no connection
timeout, never closing idle connections, or no statement timeout respectively.
Empty values fall back to the default; negative, fractional or non-numeric
values are rejected.

### Alerting (optional — inert until a sink is set)

| Variable | Default |
| --- | --- |
| `SENTRY_DSN` | unset |
| `ALERT_WEBHOOK_URL` | unset |
| `ALERT_SEVERITY_THRESHOLD` | `error` (`critical` \| `error` \| `warning`) |
| `ALERT_IGNORE_CODES` | unset |
| `ALERT_DEDUP_WINDOW_MS` | `300000` |
| `ALERT_MAX_PER_WINDOW` | `20` |
| `ALERT_RATE_LIMIT_WINDOW_MS` | `60000` |
| `ALERT_SAMPLE_RATE` | `1` |
| `ALERT_SINK_TIMEOUT_MS` | `5000` |

> Alerting only fires when `SENTRY_DSN` or `ALERT_WEBHOOK_URL` is set; with neither,
> the service logs `alerting_disabled` and behaves exactly as before.

### Metrics (optional)

| Variable | Default |
| --- | --- |
| `METRICS_TOKEN` | unset (open) |

`GET /metrics` serves Prometheus text and `GET /api/v1/metrics` serves the same
registry as JSON. Both are unlimited and unauthenticated unless `METRICS_TOKEN`
is set, in which case clients must send it as `x-metrics-token` or
`Authorization: Bearer`. To check service health without additional tooling:

```bash
curl -s localhost:3000/api/v1/metrics | jq '.gauges, .counters'
```

## 3. Local development

```bash
cd Backend
npm install
cp .env.example .env      # then set DATABASE_URL and CONTRACT_ID
```

- `npm run build` — compile TypeScript to `dist/` (`tsc`).
- `npm start` — run the real service (`node dist/index.js`).
- `npm test` — Jest.
- `npm run lint` — ESLint.
- `npm run dev` — runs `node src/stub-server.ts`, a dependency-free **stub** on
  port `3002` that serves `/health` and a mock `/api/search/posts` only. It has no
  database and no streaming, and it points at a `.ts` file, so on Node versions
  without native TypeScript support use `npm run build && npm start` instead.

With Docker Compose:

```bash
cd Backend
make docker-up      # docker compose up -d --build  (postgres + indexer)
make docker-logs    # follow logs
make docker-down    # stop, keep the pgdata volume
make docker-clean   # stop and DELETE the pgdata volume
```

## 4. Deployment

### Build and run the image

```bash
cd Backend
docker build -t kovara-indexer .
docker run -p 3000:3000 --env-file .env kovara-indexer
```

The image builds `dist/` in a builder stage, installs production dependencies only
in the final stage, runs as the non-root `appuser`, exposes `3000`, and declares a
`HEALTHCHECK` against `/health`.

### Compose

`docker-compose.yml` starts `postgres:16-alpine` (with a `pg_isready` healthcheck
and the `pgdata` volume) and the `indexer`, which waits for Postgres to be healthy.
It injects `DATABASE_URL` pointing at the `postgres` service and forces
`HOST=0.0.0.0`.

### Post-deploy checks

```bash
curl -fsS http://localhost:3000/health     # {"status":"ok","uptime":…,"db":"ok"}
curl -fsS http://localhost:3000/version    # version + git_commit + build_time
```

`status` becomes `degraded` (HTTP 200) with `db: "unavailable"` when the health
probe cannot reach PostgreSQL.

## 5. Migrations

- Applied automatically at startup by `runMigrations()`, serialised with an
  advisory lock and recorded in `schema_version`.
- A failing migration file is rolled back and **skipped** with a warning, so
  startup continues; check logs for `[migrate] Could not apply …`. It is retried
  on the next start.
- Reruns are safe (issue #972): each file is applied in its own transaction
  together with its `schema_version` row, so a crash leaves it either fully
  applied or not applied at all, and the advisory lock stops two instances
  applying the same file. Files are recorded by full name (for example
  `007_event_processing`), so an interrupted run that finished only some files
  with the same numeric prefix applies the rest on restart. A bare-prefix record
  such as `007` from an older run still counts as applied for every file with
  that prefix. If `schema_version` cannot be read, startup fails instead of
  assuming nothing is applied.
- Apply manually:

  ```bash
  cd Backend
  DATABASE_URL=postgresql://… npm run migrate
  ```

- Adding a migration: drop a new `NNN_description.sql` into `Backend/migrations/`.
  Prefer a unique numeric prefix. Files sharing a prefix (the current `007_*`,
  `008_*` and `014_*` groups) are tracked individually, but they apply in
  filename order, so order dependent files should have distinct prefixes.
- Migrations are forward-only: the repo contains no down migrations. Roll back by
  restoring a database backup.

## 6. Recovery procedures

### 6.1 Replay a missed ledger range (primary recovery tool)

If the indexer was down and ledgers were missed:

```bash
cd Backend
REPLAY_START_LEDGER=12345 REPLAY_END_LEDGER=13000 npm start
```

- Both variables must be set; the range is **inclusive** and validated before any
  RPC call (reversed or non-numeric ranges fail fast).
- Replay repopulates domain tables, then the process recovers events left in a
  non-`processed` state via `recoverPendingEvents()` and exits.
- Remove both variables and restart for live streaming.

### 6.2 Reprocess unfinished events

`events.status` is the durable record. Rows that are `new`, `processing` or
`failed` after a crash are replayed by `recoverPendingEvents()`. A `processing`
row whose worker died is safe to reset to `new` manually:

```sql
UPDATE events SET status = 'new' WHERE status = 'processing' AND indexed_at < NOW() - INTERVAL '15 minutes';
```

### 6.3 Failed / dead-lettered events

`EventStore` provides `listFailedEvents`, `requeueEvent`, `deadLetter` and
`retryFailedEvents`, and the `events` table retains `error`, `attempts`,
`failed_at` and `dead_lettered_at`. There is **no operator CLI or HTTP endpoint
wired to these** today, so retry is done either by replaying the ledger range
(6.1) or by calling those methods from a one-off script. Inspect the backlog with:

```sql
SELECT status, COUNT(*) FROM events GROUP BY status;
SELECT event_id, ledger, error, attempts FROM events WHERE status = 'failed' ORDER BY ledger DESC LIMIT 50;
```

#### Dead-letter context and redrive limits (issues #962, #963)

When an event is dead-lettered, `DeadLetterQueue` stores a bounded, single-line
error summary (at most 500 characters, with `password`, `token`, `secret`,
`authorization`, key and seed style values masked) plus the retry metadata: the
`reason` and the `attempts` count. The raw `value` is kept only after JSON
fields with sensitive names are masked and the payload is capped at 8192
characters, so a dead letter stays debuggable without retaining credentials.

`requeueBatch(keys, limit)` redrives dead letters in bounded batches. At most
`MAX_REDRIVE_BATCH` (100) keys are processed per call; the rest are returned in
`remaining` untouched and still dead. Each key is handled independently, so one
failure is reported in `failed` and does not stop the others, and unknown keys
are reported in `notFound`. Call it again with `remaining` to continue.

### 6.4 Lost or wrong cursor

The last safe cursor lives in `stream_state` (key/value). If the cursor is wrong,
restart with `START_LEDGER` set to a known-good ledger, or replay the affected
range. Handlers are idempotent, so re-processing does not duplicate rows.

### 6.5 Database outage

The API returns `503 DATABASE_UNAVAILABLE` (with a `correlationId`) and logs
`unhandled_request_error`. Restore PostgreSQL connectivity; the pool reconnects on
its own. No restart is required for the API, but the stream will log fetch errors
and back off until the database is reachable again.

## 7. Incident triage

1. `curl -fsS /health` — distinguishes "process down" from "database unreachable".
2. Read the JSON logs: every line has `ts`, `level`, `logger`, `msg` and bound
   fields. HTTP errors carry `correlationId`; use it to trace one request.
3. If alerting is configured, check the sink (Sentry/webhook) for the alert and its
   fingerprint — duplicates within `ALERT_DEDUP_WINDOW_MS` are suppressed with a
   `suppressedCount`.
4. Check the event backlog (6.3) for a growing `failed` count.
5. Check `GET /version` to confirm which build is deployed.

## 8. Shutdown and rollback

- Shutdown is graceful: `SIGTERM`/`SIGINT` aborts the stream, closes the HTTP
  server and ends the pool. Give the container a termination grace period; a
  `processing` event is recovered on the next start.
- **Rollback:** redeploy the previous image. Because migrations are forward-only
  and largely additive, a previous binary can usually run against the newer schema;
  if the schema is incompatible, restore from a backup first.

## 9. Backups, restore and scaling

### 9.1 Create a backup

Compose persists PostgreSQL in the `pgdata` named volume. The repo provides a
controlled backup process (`Backend/scripts/backup.js`, #681) that wraps
`pg_dump` and writes a **manifest** beside the dump:

```bash
cd Backend
npm run build                                   # scripts load dist/backup/backup.js
DATABASE_URL=postgresql://… npm run backup -- --out backups
```

This writes two files into `backups/` (override with `--out`):

| File | Contents |
| --- | --- |
| `kovara-<timestamp>.dump` | `pg_dump` output (`--format=custom` by default; `--format plain` also supported). |
| `kovara-<timestamp>.manifest.json` | When/where the dump was taken, its SHA-256 and byte size, and the row count of every tracked table. |

The manifest is what makes the backup verifiable: without it a truncated or
corrupted dump is indistinguishable from a good one. Keep the dump and its
manifest together — a dump without its manifest cannot be validated or restored
by the scripts.

### 9.2 Validate a backup

Run this before trusting a backup, and on a schedule against the most recent one
so corruption is found before the day it is needed:

```bash
cd Backend
npm run backup:validate -- backups/kovara-<timestamp>.dump backups/kovara-<timestamp>.manifest.json
```

It re-computes the dump's SHA-256 and size and compares them to the manifest.
Exit code `0` means the file is the backup it claims to be; `1` means it is
truncated, corrupted, or the wrong file. A non-zero exit is a hard stop — do not
restore an unvalidated dump.

### 9.3 Restore a backup

Restore is gated so a bad dump cannot be applied over a live database:

```bash
cd Backend
DATABASE_URL=postgresql://… npm run restore -- backups/kovara-<timestamp>.dump backups/kovara-<timestamp>.manifest.json
```

The script:

1. **Verifies the dump against its manifest first** and refuses to continue if
   they disagree.
2. **Names the target database and asks for confirmation.** Pass `--yes` for
   non-interactive/automated restores.
3. Runs `pg_restore --clean --if-exists` (or `psql -v ON_ERROR_STOP=1 -f` for a
   plain dump), so the restore is idempotent and re-runnable.
4. **Reads the row counts back and compares them to the manifest.** A mismatch
   exits non-zero with the offending tables listed — the restore is not
   considered done until the data is proven back.

After a successful restore, restart the indexer so it reconnects and resumes
from `stream_state` (see §6.4 if the cursor needs correcting).

### 9.4 Recovery checklist

1. Stop the indexer (`docker compose stop indexer`) so nothing writes during the
   restore.
2. `npm run backup:validate -- <dump> <manifest>` — confirm the backup is intact.
3. `npm run restore -- <dump> <manifest>` — restore and validate row counts.
4. `curl -fsS http://localhost:3000/health` after restarting — expect `db: "ok"`.
5. Check the event backlog (§6.3) and replay any ledger range missed while the
   database was down (§6.1).

### 9.5 Scaling

- Run **one** indexer instance. The stream keeps its dedup ring buffer and cursor
  in process and there is no leader election, so multiple live indexers are not
  supported as-is (the `events`/`stream_state` unique constraints keep data
  correct, but they do not coordinate the stream).
