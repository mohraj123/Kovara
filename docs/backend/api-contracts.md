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

`status` is `ok` only when the health probe query succeeds; otherwise `degraded`
with `db: "unavailable"`. `git_commit`/`build_time` come from `GIT_COMMIT` and
`BUILD_TIME` and default to `"unknown"`.

## Data endpoints

All data endpoints are mounted under `/api/v1` (and the legacy `/api`).

### Profiles

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/profiles/:address` | Returns the profile object. |

- `400 INVALID_ADDRESS` — address missing/blank, or not a 56-character `G…` Stellar address.
- `404 NOT_FOUND` — no profile for that address.

### Posts

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/posts?author=<address>&limit=<n>&offset=<n>` | `author` optional; `limit` default 20, max 100; `offset` default 0. |
| GET | `/api/v1/posts/:id` | `id` must be a non-negative integer. |
| POST | `/api/v1/posts/:id/like` | Body `{ "user": "G…", "ledger"?: number }`. `user` may also come from `x-stellar-address`. |
| POST | `/api/v1/posts/:id/tip` | Body `{ "tipper": "G…", "amount": "<int>", "fee"?: "<int>", "tx_hash": "<64-hex>" }`. |
| GET | `/api/v1/posts/:id/activity?limit=<n>&offset=<n>` | Persisted like/tip rows plus the aggregate totals. |

List response:

```json
{ "posts": [ … ], "total": 0, "limit": 20, "offset": 0, "has_more": false }
```

`POST /posts/:id/like` returns `201 { post_id, user, liked: true, like_count }`
and increments the post's `like_count`; a repeat like is `409 ALREADY_LIKED` and
does not double count. `POST /posts/:id/tip` returns
`201 { post_id, tipper, amount, fee, tip_total }` and adds `amount` to the post's
`tip_total`; a replayed `tx_hash` is `409 DUPLICATE_TIP`. `GET /posts/:id/activity`
returns `{ post_id, like_count, tip_total, likes, likes_total, tips, tips_total,
limit, offset }`. Bigint fields are serialized as strings.

Errors: `400 INVALID_QUERY` (bad limit/offset), `400 LIMIT_EXCEEDED`,
`400 INVALID_ID`, `400 INVALID_ADDRESS`, `400 INVALID_AMOUNT`,
`400 INVALID_TRANSACTION_HASH`, `404 NOT_FOUND`, `409 ALREADY_LIKED`,
`409 DUPLICATE_TIP`.

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
| GET | `/api/v1/follows/:address/counts` | Reliable `followers`/`following` totals. |
| GET | `/api/v1/follows/:address/relationship/:target` | `{ following, followed_by, mutual }`. |
| POST | `/api/v1/follows` | Body `{ "follower": "G…", "followee": "G…", "ledger"? }`. |
| DELETE | `/api/v1/follows/:follower/:followee` | Removes the edge; `404 NOT_FOLLOWING` when absent. |

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
are `null`.

`POST /follows` rejects a self-follow (`400 CANNOT_FOLLOW_SELF`) and a duplicate
(`409 ALREADY_FOLLOWING`); both addresses are validated before any database
access. `GET /follows/:address/relationship/:target` reads both edges in one
call and `GET /follows/:address/counts` reports the totals without paging.

Errors: `400 INVALID_ADDRESS`, `400 INVALID_QUERY`, `400 LIMIT_EXCEEDED`,
`404 NOT_FOLLOWING`, `409 ALREADY_FOLLOWING`.

### Pools

Mounted unconditionally on the API router.

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

When `ENABLE_ADDRESS_RATE_LIMITING !== "false"` (the default), a second limiter
covers the same prefix keyed on the request's Stellar address (taken from the
path, body `address`, or the `x-stellar-address` header). Requests with no
identifiable address are skipped — the IP limiter still protects those. The 429
body is `{ "error": "…", "code": "ADDRESS_RATE_LIMIT_EXCEEDED" }` with a
`Retry-After` header.

### Authentication and authorization

Anonymous access is the default: with no `authMiddleware` supplied to
`createApp()`, the no-op middleware passes every request through. A deployment
that requires auth supplies one, and it is applied to the API router (both
`/api` and `/api/v1`) before any route runs. `/health` and `/version` are
registered on the app, not the router, so they stay public for liveness probes.

The provided helpers live in `Backend/src/middleware/auth.ts`:
`createTokenAuthMiddleware(secret)` authenticates a `Bearer` token and fails
closed when no secret is configured; `requireRole(...roles)` authorizes an
already-authenticated caller. An unauthenticated request is `401 UNAUTHORIZED`;
an authenticated caller missing the required role is `403 FORBIDDEN`. Set
`ENABLE_AUTH_MIDDLEWARE=true` and `API_SECRET` to enable the built-in token gate
at runtime.

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
| 400 | `INVALID_ADDRESS` / `INVALID_ID` | Route parameter validation |
| 400 | `INVALID_AMOUNT` / `INVALID_TRANSACTION_HASH` / `INVALID_LEDGER` | Activity validation |
| 401 | `UNAUTHORIZED` | Auth middleware, or debug token mismatch |
| 403 | `FORBIDDEN` | Authenticated but missing the required role |
| 404 | `NOT_FOUND` | Route-level or 404 catch-all |
| 404 | `NOT_FOLLOWING` | Unfollow of a non-existent edge |
| 409 | `ALREADY_FOLLOWING` / `ALREADY_LIKED` / `DUPLICATE_TIP` | Idempotent write conflicts |
| 422 | `INVALID_THRESHOLD` | Pool threshold validation |
| 429 | `RATE_LIMIT_EXCEEDED` | IP rate limiter |
| 429 | `ADDRESS_RATE_LIMIT_EXCEEDED` | Per-address rate limiter |
| 500 | `INTERNAL_ERROR` | Unhandled error (with `correlationId`) |
| 500 | `SEARCH_UNAVAILABLE` | Search backend missing |
| 503 | `DATABASE_UNAVAILABLE` | Database error detected (with `correlationId`) |
| 503 | `REQUEST_TIMEOUT` | Request exceeded `REQUEST_TIMEOUT_MS` |
| 503 | `DEBUG_DISABLED` | `DEBUG_TOKEN` not set |

## OpenAPI

`Backend/openapi.yaml` (OpenAPI 3.1) documents the v1 read endpoints
(`/profiles/{address}`, `/posts`, `/posts/{id}`, `/follows/{address}/followers`,
`/follows/{address}/following`, `/pools/{id}`) and the follow/activity write and
read endpoints added in #674/#675 (`/follows`, `/follows/{follower}/{followee}`,
`/follows/{address}/relationship/{target}`, `/follows/{address}/counts`,
`/posts/{id}/like`, `/posts/{id}/tip`, `/posts/{id}/activity`).
It does **not** currently cover `/health`, `/version`, `/search/posts`,
`/debug/snapshot`, the `/pools` list, or the version prefix.
