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
| `ADDRESS_RATE_LIMIT_WINDOW_MS` / `ADDRESS_RATE_LIMIT_MAX` | `60000` / `100` | Applies to `setAddressRateLimit()`; the middleware is not mounted today. |
| `ENABLE_AUTH_MIDDLEWARE` | `false` | Builds a Bearer guard, but it is not applied today (see architecture gaps). |
| `API_SECRET` | unset | Expected bearer token when the auth middleware is eventually applied. |
| `EXPERIMENTAL_FEATURES` | `false` | Set `true` to mount the `/pools` routes. |
| `ENABLE_EXPERIMENTAL_ROUTES` | `false` | Parsed but unused; does **not** enable pools. |
| `DEBUG_TOKEN` | unset | Required for `GET /api/v1/debug/snapshot`; unset → `503`. |
| `GIT_COMMIT` / `BUILD_TIME` | `unknown` | Surfaced by `GET /version`. |

### Database pool

| Variable | Default |
| --- | --- |
| `DB_POOL_MAX` | `10` |
| `DB_POOL_CONNECTION_TIMEOUT_MS` | `5000` |
| `DB_POOL_IDLE_TIMEOUT_MS` | `30000` |
| `DB_STATEMENT_TIMEOUT_MS` (legacy alias `QUERY_TIMEOUT_MS`) | `30000` |

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
  startup continues; check logs for `[migrate] Could not apply …`.
- Apply manually:

  ```bash
  cd Backend
  DATABASE_URL=postgresql://… npm run migrate
  ```

- Adding a migration: drop a new `NNN_description.sql` into `Backend/migrations/`.
  **Give each migration a unique numeric prefix** — files sharing a prefix collapse
  to a single applied version (the current `007_*`/`008_*` groups are affected).
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
