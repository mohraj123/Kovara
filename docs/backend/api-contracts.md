# Kovara backend — REST API contracts

The read-only HTTP surface served by `createApp()` in `Backend/src/api/index.ts`.
Request and response shapes below were read from the route modules on `main`
(verified at commit `2c42735c443e`).

> **Response envelope caveat.** `Backend/src/api/response.ts` defines
> `sendSuccess`/`sendPaginated`/`sendError` wrappers around a
> `{ success, data, timestamp }` envelope, but most routes return bare JSON
> resources (`res.json(profile)`, `res.json({ posts, total, … })`) and route-level
> errors return `{ "error": string, "code": string }` without `success`/`timestamp`.
> Only the 404 catch-all and the global error handler use the shared envelope.
> Treat the per-endpoint shapes below as the contract.

## Versioning

- **Canonical:** `/api/v1/…`
- **Legacy:** `/api/…` is still served. Legacy responses (and most v1 responses
  built by the legacy prefix middleware) carry
  `Deprecation: true` and `Link: </api/v1/…>; rel="successor-version"`.
- `/health` and `/version` are operational endpoints and are **not** versioned.

## Operational endpoints

| Method | Path | Response |
| --- | --- | --- |
| GET | `/health` | `{ "status": "ok" | "degraded", "uptime": <seconds>, "db": "ok" | "unavailable" }` |
| GET | `/version` | `{ "version", "git_commit", "build_time", "node_version" }` |
| GET | `/metrics` | Prometheus text exposition (`text/plain; version=0.0.4`) |
| GET | `/api/v1/metrics` | JSON snapshot of the same registry |

`status` is `ok` only when the health probe query succeeds; otherwise `degraded`
with `db: "unavailable"`. `git_commit`/`build_time` come from `GIT_COMMIT` and
`BUILD_TIME` and default to `"unknown"`.

### Metrics (issue #679)

All request latency, throughput and error counts are recorded in one in-process
registry (`Backend/src/metrics/`) and exposed two ways over the same data:

- `GET /metrics` — Prometheus text. Series: `http_requests_total` (throughput),
  `http_request_duration_ms` (latency histogram), `http_errors_total`,
  `http_requests_in_flight`, `db_probe_duration_ms`, `service_up`, plus
  `process_uptime_seconds` / `process_resident_memory_bytes`.
- `GET /api/v1/metrics` — the same registry as JSON
  (`{ generated_at, series_count, counters, gauges, histograms }`) for operators
  without a Prometheus stack.

The route label is the matched route pattern (or a normalized path with `:id`
substitutions), so cardinality is bounded by the number of routes rather than
the size of the database. Scrape and health paths are not counted. When
`METRICS_TOKEN` is set, both endpoints require it via the `x-metrics-token`
header or `Authorization: Bearer`; when unset they are open.

## Data endpoints

All data endpoints are mounted under `/api/v1` (and the legacy `/api`).

### Request validation (issue #665)

Every public endpoint validates its inputs in one shared module
(`src/api/validation.ts`) before any handler or database call runs, so a
malformed request is refused at the edge rather than reaching business logic.
The result is a uniform contract:

- Every validation failure returns **exactly** `{ "error": string, "code": string }`
  with status `400` — the same `ApiErrorResponse` envelope used by the rest of
  the API. No endpoint invents its own shape or code.
- **Wallet addresses are security-sensitive.** An address must be a Stellar
  public key: `G` followed by 55 characters from the base-32 alphabet
  `A–Z`, `2–7`. The digits `0`, `1`, `8`, `9` are rejected (they never appear in
  a real strkey).
- **Identifiers** (`/posts/:id`, submission ids) are parsed as `bigint`, so an id
  above `Number.MAX_SAFE_INTEGER` is never silently rounded.
- **Bounded numeric fields** have explicit ceilings: `limit` is a positive
  integer with a per-endpoint maximum (`LIMIT_EXCEEDED` above it), and `offset`
  is a non-negative integer.
- **Cursors** are opaque, but bounded to 128 characters; a longer or non-string
  cursor is `INVALID_CURSOR`.
- The **`x-stellar-address` identity header** is rejected when well-formedness
  fails, rather than being silently ignored by the rate limiter and falling back
  to IP-based accounting.

| Code | Meaning |
| --- | --- |
| `400 INVALID_ADDRESS` | Address missing/blank, or not a base-32 `G…` Stellar public key (`x-stellar-address` included) |
| `400 INVALID_QUERY` | Malformed `limit`/`offset` or other query parameter |
| `400 LIMIT_EXCEEDED` | `limit` above the endpoint's maximum |
| `400 INVALID_ID` | Non-numeric or negative resource id |
| `400 INVALID_CURSOR` | Non-string or oversized pagination cursor |

### Profiles

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/profiles/:address` | Returns the profile object. |

- `400 INVALID_ADDRESS` — address missing/blank, or not a base-32 `G…` Stellar public key (see [Request validation](#request-validation-issue-665)).
- `404 NOT_FOUND` — no profile for that address.

### Posts

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/posts?author=<address>&limit=<n>&offset=<n>` | `author` optional; `limit` default 20, max 100; `offset` default 0. |
| GET | `/api/v1/posts/:id` | `id` must be a non-negative integer. |

List response:

```json
{ "posts": [ … ], "total": 0, "limit": 20, "offset": 0, "has_more": false }
```

Errors: `400 INVALID_QUERY` (bad limit/offset), `400 LIMIT_EXCEEDED`,
`400 INVALID_ADDRESS` (malformed `author`), `400 INVALID_ID`, `404 NOT_FOUND`.

### Search

| Method | Path | Body |
| --- | --- | --- |
| POST | `/api/v1/search/posts` | `{ "query": string, "limit"?: number, "offset"?: number }` |

- `query` is required, trimmed, whitespace-collapsed, and capped at 500 characters.
- `limit` default 20, max 100; `offset` default 0.
- Response: `{ posts, total, has_more, next_offset, prev_offset }` where each post
  is `{ id, author, content, tip_total, like_count, created_at, deleted }` and the
  bigint fields are serialized as strings.

Errors: `400 INVALID_QUERY`, `400 QUERY_TOO_LONG`, `400 LIMIT_EXCEEDED`,
`500 SEARCH_UNAVAILABLE`.

### Follows

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/follows/:address/followers?limit=<n>&offset=<n>&cursor=<c>` | `limit` default 20, max 50. |
| GET | `/api/v1/follows/:address/following?limit=<n>&offset=<n>&cursor=<c>` | Same parameters. |

Response (followers shown; `following` is identical with a different key):

```json
{
  "address": "G…",
  "followers": ["G…"],
  "total": 0,
  "limit": 20,
  "offset": 0,
  "has_more": false,
  "next_offset": null,
  "prev_offset": null
}
```

When `cursor` is supplied the keyset path is used and `next_offset`/`prev_offset`
are `null`. Errors: `400 INVALID_QUERY`, `400 LIMIT_EXCEEDED`,
`400 INVALID_ADDRESS` (malformed `:address`), `400 INVALID_CURSOR`.

### Pools (experimental — gated)

Mounted only when `EXPERIMENTAL_FEATURES === "true"`.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/pools?limit=<n>&offset=<n>` | `limit` default 20, max 100. |
| GET | `/api/v1/pools/:id` | Enriches the pool with token metadata. |

Each pool is serialized with optional `token_name`, `token_symbol`,
`token_decimals`; when metadata lookups fail the values fall back to
`"unknown"`, `"UNK"`, `7`.

Errors: `400 INVALID_QUERY`, `400 LIMIT_EXCEEDED`,
`400 INVALID_ID`, `404 NOT_FOUND`, `422 INVALID_THRESHOLD`.

### Debug snapshot

| Method | Path | Header |
| --- | --- | --- |
| GET | `/api/v1/debug/snapshot` | `x-debug-token` must equal `DEBUG_TOKEN`. |

Response:

```json
{
  "posts": [ … ],
  "profiles": [ … ],
  "pools": [ … ],
  "generated_at": "…",
  "post_count": 0,
  "profile_count": 0,
  "pool_count": 0
}
```

Each collection is capped at 1000 records; the `*_count` fields are totals.
Returns `503 DEBUG_DISABLED` when `DEBUG_TOKEN` is unset, `401 UNAUTHORIZED` on a
token mismatch.

## Cross-cutting behaviour

### Request correlation

A middleware reads `X-Correlation-Id` (or generates one) and stores it on
`req.correlationId`. It is included in the details of `DATABASE_UNAVAILABLE` and
`INTERNAL_ERROR` responses and in the HTTP error log line.

### Rate limiting

When `ENABLE_RATE_LIMITING !== "false"`, an `express-rate-limit` middleware covers
the `/api` prefix (including `/api/v1`). Defaults: 60s window, 100 requests per IP.
Exceeding it returns `429` with a `Retry-After` header and body
`{ "error": "Too many requests, please try again later.", "code": "RATE_LIMIT_EXCEEDED" }`.

See the "Known gaps" section of [`architecture.md`](./architecture.md): the
`RATE_LIMIT_*` environment variables are not currently wired to this limiter, and
the imported per-address limiter is not mounted.

### Errors

Route-level errors:

```json
{ "error": "Profile not found", "code": "NOT_FOUND" }
```

Global handler / 404 catch-all (shared envelope):

```json
{ "success": false, "error": "…", "code": "…", "timestamp": "…", "details": { "correlationId": "…" } }
```

| Status | Code | Source |
| --- | --- | --- |
| 400 | `MALFORMED_JSON` | `express.json()` syntax error |
| 400 | `INVALID_QUERY` / `LIMIT_EXCEEDED` / `QUERY_TOO_LONG` | Route parameter validation |
| 400 | `INVALID_ADDRESS` / `INVALID_ID` / `INVALID_CURSOR` | Route parameter validation (issue #665) |
| 401 | `UNAUTHORIZED` | Debug token mismatch |
| 404 | `NOT_FOUND` | Route-level or 404 catch-all |
| 422 | `INVALID_THRESHOLD` | Pool threshold validation |
| 429 | `RATE_LIMIT_EXCEEDED` | Rate limiter |
| 500 | `INTERNAL_ERROR` | Unhandled error (with `correlationId`) |
| 500 | `SEARCH_UNAVAILABLE` | Search backend missing |
| 503 | `DATABASE_UNAVAILABLE` | Database error detected (with `correlationId`) |
| 503 | `REQUEST_TIMEOUT` | Request exceeded `REQUEST_TIMEOUT_MS` |
| 503 | `DEBUG_DISABLED` | `DEBUG_TOKEN` not set |

## OpenAPI

`Backend/openapi.yaml` (OpenAPI 3.1) documents the six core v1 read endpoints:
`/profiles/{address}`, `/posts`, `/posts/{id}`,
`/follows/{address}/followers`, `/follows/{address}/following`, `/pools/{id}`.
It does **not** currently cover `/health`, `/version`, `/search/posts`,
`/debug/snapshot`, the `/pools` list, or the version prefix.
