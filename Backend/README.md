# Kovara Indexer

Event indexer for the Kovara Social contract on Stellar. Processes on-chain events and maintains a queryable database for the frontend.

> **Verified reference docs.** See [`docs/backend/`](../docs/backend/README.md) for
> the architecture, REST API contracts, and operational runbook derived from the
> code. When this README and those pages disagree, the code is the source of truth.

## Architecture

The indexer listens to Stellar contract events and processes them into a PostgreSQL database:

- **Event Handlers**: Process specific event types (PostCreated, TipEvent, LikeEvent, etc.)
- **Database**: PostgreSQL with migrations for schema management
- **Idempotency**: All handlers are idempotent using unique constraints and transaction hashes

### Runtime Flow,

The following describes the main runtime flow from startup through event handling:

1. **Configuration loading** (`src/config.ts`): Environment variables are validated and parsed before anything else runs. `DATABASE_URL` (which must be a `postgres://`/`postgresql://` connection string) and `CONTRACT_ID` (a 56-character Stellar `C…` contract strkey, checksum-verified) are required and have no fallback — startup fails immediately if either is missing or malformed. `STELLAR_RPC_URL` (default: Soroban testnet) and `START_LEDGER` (default: `0`, and rejected unless it is a finite non-negative integer) are optional but still validated when set. All configuration problems are reported together in a single error.

2. **Database initialization** (`src/index.ts:60-126`): A PostgreSQL connection pool is created. Three initialization steps run sequentially:
   - `ensureEventsTable()` — Creates the `events` table and supporting indexes if they do not exist (idempotent via `IF NOT EXISTS`).
   - `runMigrations()` — Applies any unapplied SQL migration files from the `migrations/` directory in numerical order.
   - `ensurePostSearchIndex()` — Adds and populates the `search_vector` column on the `posts` table for full-text search.

3. **API server startup** (`src/index.ts:205-207`): The Express app is created via `createApp(db)` and starts listening on the configured `HOST:PORT`. The API is ready to serve requests immediately, even before event streaming begins.

4. **Event streaming** (disabled in stub mode; `src/stream.ts`): When enabled, `streamEvents()` polls the Soroban RPC `getEvents` endpoint in a loop. Each batch of events is validated, normalized, deduplicated, and dispatched to the handler (`persistEvent`). The stream runs until an abort signal is received.

   - **Polling loop**: After each batch, the stream waits `POLL_INTERVAL_MS` (default 5s) before the next poll, unless a full page of events was returned (which implies more are available immediately).
   - **Deduplication**: An in-memory ring buffer of seen event IDs prevents redundant processing across overlapping RPC pages.
   - **Retry**: Transient network errors are retried up to 3 times with exponential backoff.

5. **Event replay** (`src/stream.ts`, BE-42): When `REPLAY_START_LEDGER` and `REPLAY_END_LEDGER` are set, the indexer starts in replay mode instead of live streaming. It iterates each ledger in the range and dispatches all matching events. This is useful for recovering from interruptions.

6. **Graceful shutdown**: On `SIGTERM` or `SIGINT`, the HTTP server stops accepting new connections and the process exits. In replay mode, the abort signal is passed so the replay loop can terminate early.

## Event Handlers

### Post Handlers (`src/handlers/post.ts`)

- **PostCreatedEvent**: Inserts new posts into the `posts` table
- **PostDeletedEvent**: Soft deletes posts by setting `deleted_at` timestamp

### Tip Handler (`src/handlers/tip.ts`)

- **TipEvent**: Records tips in `tips` table and increments `tip_total` on posts
- Idempotent via `tx_hash` unique constraint

### Like Handler (`src/handlers/like.ts`)

- **LikePostEvent**: Records likes in `likes` table and increments `like_count` on posts
- Idempotent via `(post_id, user_address)` unique constraint

## Database Migrations

Migrations live in the `migrations/` directory as numbered SQL files (e.g., `001_profiles.sql`).
On startup, the indexer automatically applies any unapplied migrations in order, tracking
them in a `schema_version` table.

```bash
# Manually trigger migrations (if running indexer with --skip-migrations):
npm run migrate
```

To add a new migration:

```bash
touch migrations/006_description.sql
# Write your DDL, then restart the indexer.
```

## Schema Versioning

The indexer uses a `schema_version` table to track which migrations have been applied:

```sql
CREATE TABLE schema_version (
    version    TEXT        PRIMARY KEY,
    name       TEXT        NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Error Handling

All API routes return structured JSON error responses with an `error` message and a
machine-readable `code` field:

```json
{ "error": "Profile not found", "code": "NOT_FOUND" }
```

## Event-Processing Reliability

A ledger event can legitimately be delivered more than once — `getEvents` pages
overlap on a cursor replay, a restart resumes from a persisted cursor, an
operator replays a range, or two replicas race during a handoff. These modules
make each of those a no-op rather than a second write.

| Module | Issue | Responsibility |
| --- | --- | --- |
| `src/idempotency.ts` | #648 | Derives, validates and parses the stable key for an event; `runOnce` executes a unit of work at most once per key. |
| `src/retry.ts` | #649 | `classifyFailure` splits errors into transient/permanent; `withRetry` applies jittered exponential backoff to the transient ones only. |
| `src/dead-letter.ts` | #650 | Counts attempts per event and dead-letters an unrecoverable failure with the full payload needed to debug and requeue it. |
| `src/aggregation/` | #651 | Daily price-index aggregation, leased so a day is computed exactly once across replicas. |

### Transient vs permanent

Retrying a permanent failure (a malformed payload, a unique-constraint
violation, a 4xx from the provider) burns the retry budget on work that can
never succeed and delays the dead-letter signal. `classifyFailure` therefore
checks, in order: an explicit `code` (SQLSTATE / syscall), then permanent
message markers, then transient markers, and **defaults to permanent** — an
error we do not understand cannot be fixed by repeating it, and the dead-letter
path exists so a human can look at it.

Backoff is exponential with **full jitter** (`random() * backoff`) rather than a
fixed delay: when a dependency restarts every replica fails at the same instant,
and a deterministic schedule would have them all retry in lockstep and reproduce
the overload.

### Idempotency keys

Keys are **derived, never caller-supplied**:

```
kovara:event:v1:<contractId>:<ledger>:<eventId>
```

Deriving them means a caller cannot reuse a key across two different events
(which would silently swallow the second). Uniqueness is enforced by the
database — `events.idempotency_key` has a unique index, and `persistEvent`
inserts with `ON CONFLICT DO NOTHING` — so two processes racing on the same
event cannot both win.

### Dead-letter queue

An event that fails permanently, or that has exhausted its retry budget, is
written to `event_dead_letters` with its topic, raw value, tx hash, ledger,
error and attempt count, so it can be reproduced and fixed. The queue keeps the
payload **unredacted** on purpose (log lines still redact payloads via
`src/logger.ts`): a redacted queue is useless for debugging. Records are
append-only; requeueing sets `requeued_at` rather than editing history.

`dead` events are excluded from startup recovery — they wait for an operator to
requeue them, and reclaiming them on every restart would defeat the queue.

### Daily aggregation

`AggregationScheduler` runs once an interval (default hourly) and aggregates the
most recent day that is still outstanding, so a window missed while the process
was down is caught up rather than skipped. Each run row in `aggregation_runs` is
the lease: a day is computed exactly once across replicas, a failed day stays
retryable, and the outcome is recorded either way.

Every aggregate carries both `run_date` (the day summarised) and `computed_at`
(when the job actually ran). They differ on a catch-up run, and conflating them
would make a late-computed historical day indistinguishable from a fresh one.

Prices are stored as `NUMERIC`, not `BIGINT`: the contract type is `i128`, and a
BIGINT would overflow on any token with 7+ decimals scaled into the smallest
unit, publishing a rounded — and wrong — cost-of-living index.

### Environment variables

All optional; the defaults are the ones documented in the modules above.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAX_HANDLER_RETRIES` | `3` | Handler attempts before a failure is dead-lettered |
| `AGGREGATION_INTERVAL_MS` | `3600000` | Daily aggregation tick interval |
| `AGGREGATION_CATCH_UP_DAYS` | `7` | How many days back to catch up |

| HTTP Status | Code                | Description                     |
|-------------|---------------------|---------------------------------|
| 400         | `INVALID_QUERY`     | Invalid query parameters        |
| 400         | `LIMIT_EXCEEDED`    | Pagination limit too high       |
| 400         | `INVALID_ADDRESS`   | Missing or malformed address    |
| 400         | `INVALID_ID`        | Missing or malformed ID         |
| 404         | `NOT_FOUND`         | Resource not found              |
| 429         | `RATE_LIMIT_EXCEEDED` | Too many requests per IP      |
| 500         | `INTERNAL_ERROR`    | Unexpected server error         |

Unhandled errors are logged with request context (`[error] GET /api/profiles/GABC123: ...`)
and return a generic 500 response.

## Health Check

```bash
curl http://localhost:3000/health
```

Returns:

```json
{ "status": "ok", "uptime": 1234.56 }
```

## Version Endpoint

```bash
curl http://localhost:3000/version
```

Returns:

```json
{
  "version": "0.1.0",
  "git_commit": "abc1234",
  "build_time": "2024-01-15T10:30:00Z",
  "node_version": "v18.17.0"
}
```

The `version` field is read from `package.json`. The `git_commit` and
`build_time` fields can be injected via environment variables at build time
(`GIT_COMMIT`, `BUILD_TIME`) and default to `"unknown"` when not set.

## API Routes

## API Versioning and Deprecation

All public data API endpoints use a major-version prefix. The current stable
contract is **v1**, at `/api/v1`; for example,
`GET /api/v1/profiles/:address`. The health (`/health`) and build metadata
(`GET /version`) endpoints are operational endpoints and are intentionally not
versioned.

The existing unversioned `/api/*` paths remain temporarily available for v1
compatibility. Their responses include `Deprecation: true` and a
`Link: </api/v1/...>; rel="successor-version"` header. New integrations must
use `/api/v1`.

Breaking changes are introduced only in a new major API version (for example,
`/api/v2`). We will document the replacement before release, keep the prior
major version available for at least six months after announcing deprecation,
and publish the planned removal date in the release notes and this README.
Non-breaking additions may be made within an existing major version.

### Profiles

- `GET /api/v1/profiles/:address` — Get profile by Stellar address

### Version

- `GET /version` — Service version and build metadata (no auth required)

### Posts

- `GET /api/v1/posts?author=<address>&limit=<n>&offset=<n>` — List posts
- `GET /api/v1/posts/:id` — Get post by numeric ID
- `POST /api/v1/search/posts` — Full-text search (body: `{ "query": "...", "limit?", "offset?" }`)

### Follows

- `GET /api/v1/follows/:address/followers?limit=<n>&offset=<n>` — List followers
- `GET /api/v1/follows/:address/following?limit=<n>&offset=<n>` — List accounts the address follows

### Pools (Experimental)

- `GET /api/v1/pools/:id` — Get pool state by ID (enabled via `EXPERIMENTAL_FEATURES=true`)

### Debug Snapshot (BE-29)

- `GET /api/v1/debug/snapshot` — Export a JSON snapshot of posts, profiles, and pools for issue triage

Requires the `x-debug-token` header matching the `DEBUG_TOKEN` environment variable. If `DEBUG_TOKEN` is not set, the endpoint returns `503 Debug endpoint disabled`.

```bash
curl -H "x-debug-token: $DEBUG_TOKEN" http://localhost:3000/api/debug/snapshot
```

Response:

```json
{
  "posts": [...],
  "profiles": [...],
  "pools": [...],
  "generated_at": "2026-07-25T12:00:00.000Z",
  "post_count": 42,
  "profile_count": 10,
  "pool_count": 3
}
```

Each collection is capped at 1000 records. The `post_count`, `profile_count`, and `pool_count` fields reflect total counts in the database.

## Common Operational Tasks

### Starting the indexer

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env with your values

# Start with Docker Compose (recommended)
docker compose up --build

# Or start manually
npm run dev        # development
npm run build && npm start   # production
```

### Running a replay after interruption

If the indexer was interrupted and missed some ledgers, set the replay range:

```bash
REPLAY_START_LEDGER=12345 REPLAY_END_LEDGER=13000 npm start
```

The indexer will process every ledger in the range [12345, 13000], then stop. After replay completes, remove the `REPLAY_*` variables and restart for live streaming.

### Checking indexer health

```bash
curl http://localhost:3000/health
# Expected: {"status":"ok","uptime":1234.56,"db":"ok"}
```

### Viewing version metadata

```bash
curl http://localhost:3000/version
```

### Exporting a debug snapshot

```bash
curl -H "x-debug-token: $DEBUG_TOKEN" http://localhost:3000/api/debug/snapshot
```

### Applying migrations manually

```bash
npm run migrate
```

### Adding a new migration

```bash
touch migrations/006_description.sql
# Write DDL, then restart the indexer.
```

### Adjusting timeouts and pool size for external dependencies

```bash
# Database pool tuning (all optional, with documented defaults)
DB_POOL_MAX=20
DB_POOL_CONNECTION_TIMEOUT_MS=5000
DB_POOL_IDLE_TIMEOUT_MS=30000
DB_STATEMENT_TIMEOUT_MS=30000  # legacy alias: QUERY_TIMEOUT_MS

# RPC fetch timeout (ms, default 15000)
RPC_FETCH_TIMEOUT_MS=30000

# API request timeout (ms, default 30000)
REQUEST_TIMEOUT_MS=60000
```

For different deployment sizes, adjust `DB_POOL_MAX` (small: `5`, medium: `10`, large: `20-30`) and timeouts without rebuilding — all are env-configurable with the defaults above.

### Monitoring the indexer

Key metrics to track:
- **Events per second**: Rate at which contract events are processed.
- **Database query latency**: Time spent in PostgreSQL queries.
- **Failed event count**: Events that could not be persisted.
- **Current indexed ledger**: The latest ledger that has been processed.

Logs include structured context for correlation:
```
[indexer] ledger=12345 type=PostCreatedEvent tx=abc...
[stream] Starting from ledger 100, contract=CDEF...
```

## Running Tests

```bash
# Run all tests
npm test

# Run route tests specifically
npm test -- routes
```

## Database Schema

### Posts Table

```sql
CREATE TABLE posts (
    id BIGINT PRIMARY KEY,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    tip_total BIGINT NOT NULL DEFAULT 0,
    like_count BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL,
    deleted_at TIMESTAMP DEFAULT NULL
);
```

### Tips Table

```sql
CREATE TABLE tips (
    id SERIAL PRIMARY KEY,
    post_id BIGINT NOT NULL REFERENCES posts(id),
    tipper TEXT NOT NULL,
    amount BIGINT NOT NULL,
    fee BIGINT NOT NULL,
    created_at TIMESTAMP NOT NULL,
    tx_hash TEXT NOT NULL UNIQUE
);
```

### Likes Table

```sql
CREATE TABLE likes (
    id SERIAL PRIMARY KEY,
    post_id BIGINT NOT NULL REFERENCES posts(id),
    user_address TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL,
    tx_hash TEXT NOT NULL UNIQUE,
    UNIQUE (post_id, user_address)
);
```

## Local Setup (Docker)

The fastest way to run the indexer and PostgreSQL together is Docker Compose.

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Compose v2

### Steps

```bash
# 1. Copy and edit environment variables
cp .env.example .env
# Edit .env — set CONTRACT_ID, START_LEDGER, and STELLAR_RPC_URL at minimum

# 2. Start both services (migrations run automatically on first boot)
docker compose up --build
```

The indexer API will be available at `http://localhost:3000`.
PostgreSQL is exposed on port `5432`.

To stop and remove containers:

```bash
docker compose down
```

To also remove the database volume:

```bash
docker compose down -v
```

### Environment Variables

See [`.env.example`](.env.example) for all required variables.

| Variable               | Description                                                         |
| ---------------------- | ------------------------------------------------------------------- |
| `DATABASE_URL`         | PostgreSQL connection string                                        |
| `STELLAR_RPC_URL`      | Soroban RPC endpoint                                                |
| `CONTRACT_ID`          | Deployed Kovara contract address                                    |
| `START_LEDGER`         | Ledger sequence to start indexing from                              |
| `HOST`                 | Bind address for the API server (recommended: `0.0.0.0`)            |
| `PORT`                 | API port (default: `3000`)                                          |
| `TRUST_PROXY`          | Express trust-proxy setting; set to `1` only behind a trusted proxy |
| `RATE_LIMIT_WINDOW_MS` | Rate-limit window in milliseconds (default: `60000`)                |
| `RATE_LIMIT_MAX`       | Maximum requests per window per IP (default: `100`)                |
| `GIT_COMMIT`           | Git commit hash (populated in `/version` response)                 |
| `BUILD_TIME`           | ISO 8601 build timestamp (populated in `/version` response)        |
| `CORS_ORIGIN`          | Allowed CORS origin(s) (default: all)  |
| `DB_POOL_MAX`          | PostgreSQL pool max clients (default: `10`)                         |
| `DB_POOL_CONNECTION_TIMEOUT_MS` | PostgreSQL pool connection timeout in ms (default: `5000`, `0` = no timeout) |
| `DB_POOL_IDLE_TIMEOUT_MS` | PostgreSQL pool idle timeout in ms (default: `30000`)              |
| `DB_STATEMENT_TIMEOUT_MS` | PostgreSQL statement timeout in ms (default: `30000`; legacy alias `QUERY_TIMEOUT_MS` still honored) |
| `QUERY_TIMEOUT_MS`     | Legacy alias for `DB_STATEMENT_TIMEOUT_MS` (default: `30000`)      |
| `RPC_FETCH_TIMEOUT_MS` | Soroban RPC fetch timeout in milliseconds (default: `15000`)       |
| `REQUEST_TIMEOUT_MS`   | HTTP request timeout in milliseconds (default: `30000`)            |
| `ENABLE_AUTH_MIDDLEWARE` | Enable authentication middleware (default: `false`)                |
| `ENABLE_RATE_LIMITING`   | Enable rate limiting middleware (default: `true`)                  |
| `EXPERIMENTAL_FEATURES`  | Enable experimental routes (e.g., pools) (default: `false`)        |
| `REPLAY_START_LEDGER`  | Start ledger for event replay (omit for live streaming)            |
| `REPLAY_END_LEDGER`    | End ledger for event replay (inclusive, requires `REPLAY_START_LEDGER`) |


### Secure environment configuration

For production deployments, keep the API bound to a non-public interface unless you need external access, and only trust proxy headers from your reverse proxy:

```bash
HOST=0.0.0.0
PORT=3000
TRUST_PROXY=1
```

If the indexer is exposed directly or behind a network you do not control, leave `TRUST_PROXY=0` so forwarded client IPs are not trusted implicitly.

## Manual Setup

### Prerequisites

- Node.js 18+
- PostgreSQL 14+

### Installation

```bash
npm install
```

### Database Setup

```bash
# Apply migrations manually
psql "$DATABASE_URL" -f migrations/001_profiles.sql
psql "$DATABASE_URL" -f migrations/002_posts.sql
psql "$DATABASE_URL" -f migrations/003_follows.sql
psql "$DATABASE_URL" -f migrations/004_tips_likes.sql
psql "$DATABASE_URL" -f migrations/005_pools.sql
```

### Configuration

```bash
cp .env.example .env
# Edit .env with your values
```

## Running

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test -- post.test.ts
```

## Idempotency

All event handlers are designed to be idempotent:

1. **PostCreatedEvent**: Uses `ON CONFLICT (id) DO NOTHING`
2. **PostDeletedEvent**: Only updates if `deleted_at IS NULL`
3. **TipEvent**: Uses `tx_hash` unique constraint
4. **LikeEvent**: Uses `(post_id, user_address)` unique constraint

This ensures the indexer can safely replay events without data corruption.

## CORS

The API uses the [`cors`](https://www.npmjs.com/package/cors) middleware and allows
all origins by default. To restrict access in production, set the `CORS_ORIGIN`
environment variable:

```bash
# Allow a single origin
CORS_ORIGIN=https://app.example.com

# Allow multiple origins (comma-separated)
CORS_ORIGIN=https://app.example.com,https://admin.example.com
```

When `CORS_ORIGIN` is not set, all origins are permitted (useful during development).
See `.env.example` for the full list of environment variables.

## Rate Limiting

All `/api/*` routes are protected by a rate limiter (express-rate-limit) by default.
Rate limiting can be disabled by setting `ENABLE_RATE_LIMITING=false`. The
default window is 60 seconds with 100 requests per IP. Configurable via:

| Variable               | Default | Description                          |
| ---------------------- | ------- | ------------------------------------ |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window duration in milliseconds      |
| `RATE_LIMIT_MAX`       | `100`   | Maximum requests per window per IP   |

When the limit is exceeded, the API returns `429 Too Many Requests` with a
`Retry-After` header and a JSON body containing `RATE_LIMIT_EXCEEDED`.

### Tiered Limits

A single budget per IP treats a `POST /tips` and a `GET /health` as equivalent,
even though one costs a transaction and the other costs nothing. Endpoints that
are genuinely more expensive get a tighter budget:

| Tier    | Applies to                                       | Default budget |
| ------- | ------------------------------------------------ | -------------- |
| search  | `GET` on `/search`, `/leaderboard`, `/index`, `/analytics`, `/history` | 30 / 60s |
| write   | `POST`, `PUT`, `PATCH`, `DELETE`                 | 20 / 60s       |

A tier rejection returns `429` with `RATE_LIMIT_TIER_EXCEEDED`, a `retry_after`
field, and an `X-RateLimit-Tier` header. Budgets are configurable in code via
`setTierConfig()`, and the whole mechanism is off with
`ENABLE_TIERED_RATE_LIMITS=false`.

### Abuse Detection

`ENABLE_ABUSE_DETECTION=false` disables the detector. A per-window counter
cannot see a client that stays just under the budget — 1 request/second is
60/minute against a 100/minute limit, so it is never throttled and can read the
whole database indefinitely. The detector watches the *shape* of traffic rather
than its volume:

| Signal       | Detected by                                                    |
| ------------ | -------------------------------------------------------------- |
| `enumeration`| Many distinct resources, most returning 404/400                |
| `scraping`   | Many distinct real resources with few repeats                  |
| `burst`      | Requests concentrated in a 1-second sub-window                 |
| `scanner`    | Traversal/SQLi in the path, or a known scanner user agent      |

Cooldowns are **temporary and escalating** (30s, doubling, capped at 15 min)
rather than permanent. A permanent ban triggered by a heuristic is
unrecoverable when the heuristic is wrong — a shared NAT or corporate proxy
would take out every user behind it with no way back but operator intervention.
Identities are hashed, so logs do not become a registry of who was throttled.

Operator endpoints:

```bash
curl http://localhost:3000/api/v1/abuse
# { trackedIdentities, detections, blockedRequests, blockedIdentities,
#   recentEvents: [...], config: {...} }

curl -X POST http://localhost:3000/api/v1/abuse/unblock \
  -H "Content-Type: application/json" -d '{"identity":"ip:1a2b3c4d5e6f7a8b"}'
```

`unblock` lifts a block early — the escape hatch for a false positive — and
returns `404` rather than a silent `200` when no identity matched, so a typo is
visible.

## Unified Search

`GET /api/v1/search` searches profiles, posts, and categories together and
returns them in one ranked, interleaved page:

```bash
curl "http://localhost:3000/api/v1/search?q=stellar&type=posts,profiles&limit=20&offset=0"
```

| Param    | Default | Notes                                          |
| -------- | ------- | ---------------------------------------------- |
| `q`      | —       | Required, 1–200 chars, whitespace-normalized    |
| `type`   | all     | Comma-separated subset of the entity names     |
| `limit`  | `20`    | Max 100                                        |
| `offset` | `0`     | Max 10000, to bound deep-scan cost             |

Ranking combines text relevance (0.7), log-scaled engagement (0.2), and recency
(0.1), with `id` as a final tiebreak so the order is **total and reproducible** —
a relevance order that varies between identical requests makes a client paging
through results see rows repeat and skip.

Two supporting endpoints: `GET /api/v1/search/facets?q=…` for per-entity counts,
and `GET /api/v1/search/cache` for live cache counters.

### Performance

The existing `POST /search/posts` matched with

```sql
search_vector @@ plainto_tsquery('simple', $1) OR content ILIKE '%' || $1 || '%'
```

A leading-wildcard `ILIKE` cannot use a btree index, so the planner cannot prove
the `OR` is selective and falls back to a **sequential scan** — meaning the GIN
index on `search_vector` was never actually used.

Migration `013_search_performance.sql` fixes this by enabling `pg_trgm` and
adding a GIN trigram index on `posts.content`, so *both* branches of the `OR` are
index-backed and the planner can prefer an index scan. It also recreates
`idx_posts_search_vector` as a partial index (`WHERE deleted_at IS NULL`), since
deleted posts can never be returned by any search path.

`pg_trgm` is created inside a `DO` block that tolerates `insufficient_privilege`
and `undefined_file`. Where it is unavailable the migration still succeeds and
substring search degrades to the same sequential scan as before — it is a
performance migration, never a hard startup failure.

### Optional columns

`posts.search_vector` is created at runtime by `ensurePostSearchIndex()` and
`posts.category` is not created by any migration in this repository. SQL naming a
non-existent column is a *parse* error, so a `COALESCE(search_vector, …)` fallback
cannot help. The store therefore probes `information_schema.columns` once, caches
the result for 60s, and collapses concurrent probes into one query. Missing
`search_vector` falls back to an inline `to_tsvector`; missing `category` yields
an empty result set, because "no categories exist" is the correct answer for a
schema that has none.

## Response Caching

Cached endpoints return a pre-serialized JSON body with an `X-Cache` header of
`HIT-MISS` or `STALE`, so a client can tell a fresh result from a stale-but-served
one rather than silently acting on stale data.

Invalidation uses the shared `cache_epoch` table rather than TTL alone. These
services run multiple replicas against one Postgres, and a write on replica A is
invisible to replica B's memory for the whole TTL — a read-your-own-write
violation that looks like a cache bug and is actually a design bug. Every writer
bumps the epoch; a reader compares it against the epoch its entry was stored
with. The epoch is polled at most once per 500ms, because reading it per request
would add a database round trip to each one and give back what caching saves.
Consistency bound: a cross-replica write becomes visible within 500ms, and never
later than the entry TTL.

Misses are protected by **single-flight**: concurrent misses on one key share a
single upstream call. Without it, a hot key expiring sends every concurrent
request to the database at once, multiplying load at exactly the moment the
database can least absorb it. Past the fresh window the last known value is
served while a refresh runs in the background; if that refresh fails the previous
value is served **flagged stale** rather than deleted, so a blip does not empty
the cache and turn every key into a cold miss.

## Response Serialization

`api/serialize.ts` replaces per-route conversion and does not rely on the global
`BigInt.prototype.toJSON` override:

```ts
import { defineSerializer } from "./api/serialize";

const serializePost = defineSerializer<PostRow>({
  id: {},
  author: {},
  tip_total: {},
  // creator_token is an internal column: never named, therefore never published.
});
```

Conversions are explicit: `bigint` → decimal **string** (never `Number`, which
would silently round past 2^53-1 — tip totals in the smallest unit exceed that),
`Date` → ISO 8601, invalid `Date` → `null`, `NaN`/`Infinity` → `null`,
`Buffer` → base64, `undefined`/functions/symbols → omitted. Circular references
throw with the path rather than emitting `"[Circular]"`, because a cycle is a
programming error and shipping a marker turns a bug into a silently wrong
contract.

**Tenant-safe** is the property that rules out a plain replacer. A response
assembled from a database row carries whatever columns happened to be there, so
the safe path is a *declared schema*: the service states which fields it intends
to publish and the serializer projects exactly those. A `SELECT *` that gains
`creator_token` cannot start leaking it, because it was never named.
Untrusted `toJSON` is ignored by default, and `__proto__` / `constructor` /
`prototype` keys are dropped.

## Full-Text Search

Legacy single-entity search, retained for existing clients:

```bash
curl -X POST http://localhost:3000/api/search/posts \
  -H "Content-Type: application/json" \
  -d '{"query": "stellar", "limit": 10, "offset": 0}'
```

The search uses PostgreSQL full-text search (`tsvector`/`tsquery`) for efficient
content matching. Results include `id`, `author`, `content`, `tip_total`,
`like_count`, and `created_ledger`. See
[Performance](#performance-1) for the index situation.

## Token Metadata Enrichment

Pool responses include optional token metadata when available:

```json
{
  "pool_id": "...",
  "token": "GABCD...",
  "token_name": "Kovara Token",
  "token_symbol": "KOVA",
  "token_decimals": 7,
  ...
}
```

Metadata is fetched via the `getTokenMetadata` database method, which can be
populated from on-chain contract data or a supplementary table.

## Monitoring

### Health Check

```bash
curl http://localhost:3000/health
```

Returns `200 OK` with `{ "status": "ok", "uptime": <seconds> }`.

### Metrics

- Events processed per second
- Database query latency
- Failed event count
- Current indexed ledger

## Deployment

### Docker

```bash
docker build -t Kovara-indexer .
docker run -p 3000:3000 --env-file .env Kovara-indexer
```

### Kubernetes

```bash
kubectl apply -f k8s/deployment.yaml
```

## Rewards, audit, and feeds (#656-#659)

### Reward calculation (#656)

`src/rewards/rules.ts` is pure. It reads the recorded submission and
verification facts and returns integers — no clock, no randomness, no globals —
so the same stored data always produces the same rewards. That is what makes a
disputed payout arguable rather than mysterious.

| Rule | Behaviour |
| --- | --- |
| Rejected submission | Pays nothing — not to the submitter, and not to the verifier who rejected it. Rejecting bad data is a cost the protocol bears, not a paid service. |
| Pending submission | Pays nothing yet; verifier rewards are also withheld, because a pending submission can still be rejected. |
| Verified submission | `base`, scaled by the corroboration multiplier, plus `verificationReward` to each deduplicated approving verifier. |
| Flagged for review | The submitter's reward is **held** at `pendingReviewBps` and marked `pending`, not `claimable`. Held rather than clawed back, so a reversal never has to recover money already spent. |

Corroboration is weighted `1/n^0.5` per submitter and capped, so agreement is
rewarded but a colluding group cannot scale a payout without limit.

**Duplicate votes are prevented twice.** In application code by
`dedupeVerifications`, and in the database by `PRIMARY KEY (submission_id,
verifier)` on `verifications` — so the rule holds even if a caller forgets to
check. The *first* vote is the one that counts: a verifier who approves and then
rejects is recorded as a duplicate rather than converting an approval into a
rejection, because letting someone change their vote after seeing the reward
would make the reward a function of when they looked.

**Self-verification pays nothing.** An address cannot both create data and
certify it.

All amounts are `bigint`; multipliers are basis points applied with integer
arithmetic, so the rules and the ledger cannot drift apart by a rounding step.

### Claims (#657)

`processing` is a real state, not a formality.

- **No double-claim.** Accruals are claimed under `FOR UPDATE`, so two
  concurrent claims of the same rows serialise and the second finds nothing
  claimable. `idempotency_key` is `UNIQUE`, and that constraint — not the
  application check — is what makes a concurrent retry resolve to one payout.
- **A failed payout releases the accruals** back to `claimable`. A crash
  mid-payout leaves the money `processing` and visible as such, rather than lost
  or double-paid.
- **A completed claim is never reversed.** The transfer already happened;
  pretending otherwise would be a lie in the ledger.

Balances are always derived by summing `reward_accruals`; no running total is
stored, so a total and its underlying lines cannot disagree. An in-flight claim
is reported separately from `claimed` so a payout in progress reads as in
progress.

```
GET  /api/v1/rewards/:address
GET  /api/v1/rewards/:address/claims?state=&limit=&offset=
GET  /api/v1/rewards/:address/accruals?state=&limit=&offset=
POST /api/v1/rewards/:address/claim      { "idempotency_key": "..." }
```

`idempotency_key` is **required** on claim. A client that times out mid-request
cannot tell whether the payout landed, so a retry has to be safe by default —
which means the key comes from the caller, not from the server. Reusing a key
returns the original claim and moves no money.

A claim with nothing claimable returns `200` with a zero-amount `processing`
claim: that is a statement about the caller's balance, not a server fault.

### Audit log (#658)

An audit log that an operator with write access can quietly edit is not an audit
log. Each entry hashes its own canonical content **and** the previous entry's
hash:

```
hash(n) = SHA256(canonical(record n) || hash(n-1))
```

Altering or removing any record breaks verification for every record after it,
and `GET /api/v1/audit/:stream/verify` reports the first break. The canonical
form is fixed-order and length-prefixed, not `JSON.stringify` of an arbitrary
object: field order is not guaranteed across versions, and without a length
prefix `{a: "bc"}` and `{ab: "c"}` could hash identically.

The chain is **per stream** (one per contract), so concurrent writers for
different contracts do not serialise. Appends lock the stream's head row — the
alternative, read-head-then-insert, lets two concurrent appends read the same
head and silently fork the chain.

> **Operational note.** The chain only means something if the application role
> cannot `UPDATE` or `DELETE` `audit_log` in production. Revoke those grants
> after setup:
>
> ```sql
> REVOKE UPDATE, DELETE ON audit_log FROM <app_role>;
> ```

Audit writes never fail an event. A full audit table must not stall the indexer,
so a write error is logged loudly and the event proceeds; a gap is detectable
afterwards because the chain records where a record should have continued from.

```
GET /api/v1/audit?stream=&action=&outcome=&subject=&actor=&ledger=&from=&to=&limit=&offset=
GET /api/v1/audit/:stream/verify
```

### Submission feed (#659)

```
GET /api/v1/submissions?status=&submitter=&country=&category=&from=&to=&limit=&offset=&summary=true
GET /api/v1/submissions/:id
```

Filters combine with AND. An unrecognised `status` is a `400` rather than being
ignored — silently returning everything because a client typo'd a filter is the
failure most likely to go unnoticed, because the response is still a
plausible-looking list. An empty feed is `200` with `total: 0`, not `404`.

Ordering is `submitted_at DESC, id DESC`. The `id` tiebreak is what makes offset
pagination consistent: without it, two rows sharing a timestamp can swap places
between pages and a client sees a record twice or misses one. `has_more` is
derived from the returned row count, so the final page reports `false` even when
`total` is an exact multiple of the page size.

`summary=true` returns a per-status breakdown. It deliberately ignores the
`status` filter — a summary that could only ever report the one status that was
filtered to would be useless.

> Offset paging is the right choice for a stable snapshot, and the wrong one for
> a continuously-written feed, where inserts during a walk shift the window. If
> this feed needs to be tailed, add a keyset variant (`?after=<id>`) rather than
> raising the offset cap.

### Migration note

`012_rewards_audit_submissions.sql` follows `010` (PR #773) and `011` (PR #774).
The runner keys applied migrations by **filename prefix alone**, so each number
is claimed by exactly one file. Note that `upstream/main` already has three
`007_*.sql` and three `008_*.sql` files, so by that same rule only the first of
each is ever applied — worth confirming those columns and indexes exist in your
environment.
## Index analytics (#652-#655)

Daily price-index aggregation with robust statistics, plus the read endpoints
that serve it.

### How the index is computed

`src/analytics/index-aggregation.ts` is pure and side-effect free. The pipeline,
in order:

1. **Status and absolute bounds** — rejected and (by default) pending
   submissions are dropped, along with non-positive values and anything outside
   an optional `minValue`/`maxValue`. These run first so a rejected submission
   cannot influence the thresholds used to judge the others.
2. **MAD filter** — rejects values beyond `madThreshold` (default 3)
   median-absolute-deviations from the median. MAD is used rather than standard
   deviation because it is built from the same robust centre and does not let
   outliers inflate the measure meant to detect them.
3. **Tukey IQR fence** — rejects values outside
   `[Q1 - 1.5*IQR, Q3 + 1.5*IQR]`, catching skew a symmetric MAD window misses.
4. **Per-submitter cap** — `maxSubmitterShare` bounds any one address's
   influence, dropping their excess lowest-value-first.

What survives is reduced to two values, kept deliberately separate:

- **Median** — the published `median_value`. Up to half the sample can be
  arbitrarily wrong before it moves at all.
- **Credibility-weighted mean** — the published `weighted_value`. Weights are
  `1 / n^0.5` per submitter, so corroboration counts but volume alone does not
  decide the index.

All arithmetic is integer (`bigint`). Prices are the contract's `i128` in the
smallest fixed-point unit, and a median that rounds differently between two runs
is not reproducible.

### Why `maxValue` matters

No statistical method can distinguish a legitimate extreme from a unit mistake
— someone submitting rent in kobo rather than naira. That is a domain bound, so
set it per deployment if your price range is known.

### Reading the exclusion log

Every excluded submission is recorded in `price_index_filter_decisions` with the
reason and the threshold that produced it. This is what makes a disputed index
value reviewable rather than merely arguable:

```bash
curl "localhost:3000/api/v1/index/NG/rent/decisions?date=2024-01-15"
```

### Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/index/history` | Historical index values, newest first |
| `GET /api/v1/index/leaderboard` | Countries ranked by index, or by contribution volume with `scope=contributors` |
| `GET /api/v1/index/:country/:category/decisions` | Filter decisions behind a published value |

Query parameters: `country`, `category`, `from`, `to`, `limit`, `offset`.
`limit` is capped at 100; `offset` is unbounded, so deep pagination is available
but should be used with the `has_more` flag rather than assumed.

An empty result is a `200` with `total: 0`, not a `404` — a country with no
submissions yet is a fact about the world, not a bad request.

### Scheduling

`runDailyIndexAggregation` runs at startup for the previous UTC day, and is
idempotent: both tables are upserted, so a re-run converges on the same state
rather than double-counting. Cross-replica runs are serialised with a Postgres
advisory lock, which Postgres releases automatically if a replica dies mid-run.

The job takes an optional `runDate` for backfill, and `maxPairs` to bound a
catch-up run.

### Migration note

`011_price_index_analytics.sql` starts at `011`, not `010`, because
`010_event_reliability.sql` claims `010` on the
`feature/event-processing-reliability` branch. The runner keys applied
migrations by filename prefix alone (`migrate.ts`), so two files sharing a
prefix means one is silently skipped. **If you add a migration while both
branches are open, pick a prefix not already claimed.**

## Troubleshooting

### Indexer falls behind

- Check Stellar RPC rate limits
- Increase database connection pool size
- Scale horizontally with multiple indexer instances

### Duplicate events

- Verify idempotency constraints are in place
- Check transaction hash uniqueness
- Review event replay logic

### Missing events

- Verify START_LEDGER is correct
- Check Stellar RPC connectivity
- Review event filter configuration

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines.

## License

MIT

