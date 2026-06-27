# Kovara Indexer

Event indexer for the Kovara Social contract on Stellar. Processes on-chain events and maintains a queryable database for the frontend.

## Architecture

The indexer listens to Stellar contract events and processes them into a PostgreSQL database:

- **Event Handlers**: Process specific event types (PostCreated, TipEvent, LikeEvent, etc.)
- **Database**: PostgreSQL with migrations for schema management
- **Idempotency**: All handlers are idempotent using unique constraints and transaction hashes

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

## API Routes

### Profiles

- `GET /api/profiles/:address` — Get profile by Stellar address

### Posts

- `GET /api/posts?author=<address>&limit=<n>&offset=<n>` — List posts
- `GET /api/posts/:id` — Get post by numeric ID
- `POST /api/search/posts` — Full-text search (body: `{ "query": "...", "limit?", "offset?" }`)

### Follows

- `GET /api/follows/:address/followers?limit=<n>&offset=<n>` — List followers
- `GET /api/follows/:address/following?limit=<n>&offset=<n>` — List accounts the address follows

### Pools

- `GET /api/pools/:id` — Get pool state by ID

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

## API Routes

The indexer exposes a REST API on port `3001` (configurable via `PORT`). All endpoints are prefixed with `/api` and return `application/json`. Large integers (post IDs, token amounts) are serialised as strings to avoid floating-point loss.

**Base URL:** `http://localhost:3001`

> **Rate limit:** 100 requests per 60 seconds per IP by default (overridable via `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`). Exceeding the limit returns `429` with a `Retry-After` header.

### Profiles

#### `GET /api/profiles/:address`

Returns the on-chain profile for a Stellar account address.

**Path parameter**

| Param     | Type     | Description                      |
| --------- | -------- | -------------------------------- |
| `address` | `string` | Stellar account address (`G...`) |

**Response `200`**

```json
{
  "address": "GABC...XYZ",
  "username": "alice",
  "creator_token": "CABC...TOKEN",
  "updated_ledger": 12100000
}
```

**Response `404`** — profile not found.

---

### Posts

#### `GET /api/posts`

Paginated list of posts. Optionally filtered by author.

**Query parameters**

| Param    | Type     | Default | Constraints | Description                    |
| -------- | -------- | ------- | ----------- | ------------------------------ |
| `author` | `string` | —       | —           | Filter by Stellar address      |
| `limit`  | `number` | `20`    | 1–100       | Maximum items to return        |
| `offset` | `number` | `0`     | ≥ 0         | Items to skip before returning |

**Response `200`**

```json
{
  "posts": [
    {
      "id": "42",
      "author": "GABC...XYZ",
      "content": "Hello Kovara!",
      "tip_total": "500000000",
      "like_count": "3",
      "created_ledger": 12200000,
      "deleted": false,
      "deleted_ledger": null
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0,
  "has_more": false
}
```

**Error codes:** `INVALID_QUERY`, `LIMIT_EXCEEDED`

---

#### `GET /api/posts/:id`

Returns a single post by its numeric ID.

**Path parameter**

| Param | Type  | Description                      |
| ----- | ----- | -------------------------------- |
| `id`  | `u64` | Post ID assigned by the contract |

**Response `200`** — same shape as a single item in the list above.

**Response `400`** — `INVALID_ID` (non-numeric or negative ID).

**Response `404`** — post not found.

---

#### `POST /api/search/posts`

Full-text search over post content.

**Request body**

```json
{
  "query": "stellar soroban",
  "limit": 20,
  "offset": 0
}
```

| Field    | Type     | Required | Default | Constraints      |
| -------- | -------- | -------- | ------- | ---------------- |
| `query`  | `string` | yes      | —       | non-empty string |
| `limit`  | `number` | no       | `20`    | 1–100            |
| `offset` | `number` | no       | `0`     | ≥ 0              |

**Response `200`**

```json
{
  "posts": [...],
  "total": 1,
  "has_more": false
}
```

**Error codes:** `INVALID_QUERY`, `LIMIT_EXCEEDED`

---

### Follows

#### `GET /api/follows/:address/followers`

Paginated list of accounts that follow `:address`.

**Path parameter**

| Param     | Type     | Description                      |
| --------- | -------- | -------------------------------- |
| `address` | `string` | Stellar account address (`G...`) |

**Query parameters**

| Param    | Type     | Default | Constraints |
| -------- | -------- | ------- | ----------- |
| `limit`  | `number` | `20`    | 1–100       |
| `offset` | `number` | `0`     | ≥ 0         |

**Response `200`**

```json
{
  "address": "GABC...XYZ",
  "followers": ["GBOB...XYZ", "GCAR...XYZ"],
  "total": 2,
  "limit": 20,
  "offset": 0,
  "has_more": false
}
```

---

#### `GET /api/follows/:address/following`

Paginated list of accounts that `:address` follows.

**Query parameters:** same as `/followers`.

**Response `200`**

```json
{
  "address": "GABC...XYZ",
  "following": ["GDAVE...XYZ"],
  "total": 1,
  "limit": 20,
  "offset": 0,
  "has_more": false
}
```

---

### Pools

#### `GET /api/pools/:id`

Returns the current state of a community pool.

**Path parameter**

| Param | Type     | Description            |
| ----- | -------- | ---------------------- |
| `id`  | `string` | Pool symbol identifier |

**Response `200`**

```json
{
  "pool_id": "CREATOR_FUND",
  "token": "CABC...TOKEN",
  "balance": "5000000000",
  "admins": ["GABC...XYZ"],
  "threshold": 2,
  "created_ledger": 12300000,
  "updated_ledger": 12350000
}
```

**Response `400`** — `INVALID_ID` (empty ID).

**Response `404`** — pool not found.

---

### Error format

All error responses share the same shape:

```json
{
  "error": "human-readable message",
  "code": "MACHINE_READABLE_CODE"
}
```

| Code                  | HTTP status | Meaning                                |
| --------------------- | ----------- | -------------------------------------- |
| `NOT_FOUND`           | 404         | Resource does not exist in the index   |
| `INVALID_QUERY`       | 400         | Missing or malformed request parameter |
| `INVALID_ID`          | 400         | Missing or malformed path ID           |
| `INVALID_ADDRESS`     | 400         | Missing or malformed Stellar address   |
| `LIMIT_EXCEEDED`      | 400         | `limit` parameter exceeds the maximum  |
| `RATE_LIMIT_EXCEEDED` | 429         | Too many requests from this IP         |
| `INTERNAL_ERROR`      | 500         | Unexpected server error                |

---

## Monitoring

### Health Check

```bash
curl http://localhost:3000/health
```

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
