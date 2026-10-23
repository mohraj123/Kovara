# Kovara backend — REST API contracts

The read-only HTTP surface served by `createApp()` in `Backend/src/api/index.ts`.
Request and response shapes below were read from the route modules on `main`
(verified at commit `2c42735c443e`).

> **Response envelope caveat.** Successful routes return endpoint-specific JSON
> resources, not a common success envelope. Errors use the common
> `{ "error": string, "code": string }` shape. Internal exception messages and
> arbitrary error details are never serialized to clients; diagnostic context is
> available in server logs and the `X-Correlation-Id` response header.

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
- **Typed error details (BE-30).** Internally, every failure is represented as a
  `ValidationIssue { status, code, error, field }`. The `field` property names the
  request field that failed (never the submitted value) and is available for
  structured server logging. The HTTP response body uses only `error` and `code`.
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

#### Unsafe numeric identifier rejection (BE-31)

`parseNumericId` rejects all inputs that are not a non-negative integer string,
**before** any database call:

- Negative values (`-1`, `-99`) → `400 INVALID_ID`
- Fractional values (`1.5`, `0.1`) → `400 INVALID_ID`
- Hex / scientific notation (`0xff`, `1e10`) → `400 INVALID_ID`
- Strings with trailing letters (`123abc`) → `400 INVALID_ID`
- Non-string, non-number types (`null`, `{}`) → `400 INVALID_ID`
- Values above `Number.MAX_SAFE_INTEGER` are preserved exactly as `bigint`
  (no silent rounding).

#### Optional address filter normalization (BE-32)

Endpoints that accept an optional wallet address filter (`author`, wallet
lookup parameters) use `parseOptionalStellarAddress`:

| Input | Interpretation |
| --- | --- |
| `undefined` / `null` / `""` | Absent — no filter applied; proceeds to business logic |
| A valid Stellar address | Filter applied |
| A malformed address | `400 INVALID_ADDRESS` — rejected before business logic |

This means a client that omits the filter, sends an empty string, or sends
`null` all get the same "no filter" behaviour. A client that sends a value that
looks like an address but is malformed (wrong alphabet, wrong length) is
rejected with the same `INVALID_ADDRESS` code as any other address failure.

| Code | Meaning |
| --- | --- |
| `400 INVALID_ADDRESS` | Address missing/blank, or not a base-32 `G…` Stellar public key (`x-stellar-address` included) |
| `400 INVALID_QUERY` | Malformed `limit`/`offset` or other query parameter |
| `400 LIMIT_EXCEEDED` | `limit` above the endpoint's maximum |
| `400 INVALID_ID` | Non-numeric or negative resource id |
| `400 INVALID_CURSOR` | Non-string or oversized pagination cursor |
| `400 INVALID_CONTENT` | Post content missing, blank, over the 280-character limit, or not a string |
| `400 INVALID_FIELD` | A profile field failed validation (currently `username`) |

### Bounded free text (issue #921)

`posts.content` is a plain `TEXT` column with no length constraint, so an
oversized post is stored happily and only fails later — when a client renders
it, or when a list endpoint serializes it. The bound is therefore applied at the
API edge by `parsePostContent` in `src/api/validation.ts`:

- The limit is **280 UTF-16 code units**, matching the cap the web client
  enforces, so a post the UI accepts is never rejected by the API.
- The **submitted value is measured verbatim**, not a trimmed copy. Content is
  stored as submitted, so trimming before measuring would silently rewrite the
  post and let padding slip past the limit.
- Empty or whitespace-only content is `INVALID_CONTENT` rather than an empty
  post row.

### Profiles

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/profiles/:address` | Returns the profile object. |
| PUT | `/api/v1/profiles/:address` | Updates `username` (required) and `creator_token` (optional). |

- `400 INVALID_ADDRESS` — address missing/blank, or not a base-32 `G…` Stellar public key (see [Request validation](#request-validation-issue-665)).
- `404 NOT_FOUND` — no profile for that address.
- `400 INVALID_FIELD` — `username` missing, blank, or longer than 32 characters.
- `400 INVALID_ADDRESS` — `creator_token` present but not a Stellar public key.

**Profile updates are all-or-nothing (issue #923).** Every field is validated
before anything is written and the handler issues at most one write, so a
request carrying one bad field never applies the others. Validating field by
field inside the write loop is precisely what produces partial updates: the
profile ends up with the new username and the old creator token, with nothing in
the response to say half the request was refused. Omitting `creator_token`
leaves the stored value untouched rather than clearing it.

**The response shape is stable (issue #926).** A profile always serializes with
the same four keys, whatever the row happens to contain:

| Key | Type | When unset |
| --- | --- | --- |
| `address` | string | never — it is the primary key |
| `username` | string | `""` |
| `creator_token` | string | `""` |
| `updated_ledger` | integer | `0` |

A row that has never had a `creator_token`, or that predates a column being
added, comes back from Postgres with that property absent. Passing it straight
through would drop the key entirely, so the same account serializes differently
depending on which columns happen to be populated — and a client has to treat a
missing key and an explicit value as two different things. Normalizing here
means the keys are always present, so `'creator_token' in profile` and any
generated type agree with the documented shape.

**Address casing (issue #925).** A Stellar strkey is base-32 over `A–Z` and
`2–7`, so **upper case is the canonical form**. `normalizeAddress` trims, folds
to upper case and then validates the folded value, so every caller gets the same
string back for the same account. Without this, a profile created from `gabc…`
is not found again by a lookup for `GABC…` and a second row is created for the
same account. Folding happens *before* validation so the character set is still
checked exactly: `0`, `1`, `8` and `9` remain rejected in either case.

### Posts

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/posts?author=<address>&limit=<n>&offset=<n>&cursor=<c>` | `author` optional; `limit` default 20, max 100; `offset` default 0. |
| GET | `/api/v1/posts/:id` | `id` must be a non-negative integer. |
| DELETE | `/api/v1/posts/:id` | Soft-deletes a post. See [deletion semantics](#post-deletion-semantics-issue-920). |

List response:

```json
{ "posts": [ … ], "total": 0, "limit": 20, "offset": 0, "has_more": false, "next_cursor": null }
```

Errors: `400 INVALID_QUERY` (bad limit/offset), `400 LIMIT_EXCEEDED`,
`400 INVALID_ADDRESS` (malformed `author`), `400 INVALID_ID`, `400 INVALID_CURSOR`,
`404 NOT_FOUND`.

#### Cursor pagination (issue #918)

Two styles coexist, and the presence of `cursor` selects between them:

- **No `cursor`** — the original `limit`/`offset` behaviour, unchanged, so
  existing clients are unaffected. `next_cursor` is `null`.
- **`cursor` present** — keyset pagination. `offset` is reported as `null` and
  ignored, because mixing the two produces a page the caller cannot reason about.
  `next_cursor` is the opaque boundary for the next request, and is `null` once a
  short page comes back.

Offset pagination cannot express a stable page: a post created *between* two
page requests shifts every later row by one, so the client sees the row it
already read and misses another. The cursor carries the boundary row's
`(created_at, id)` pair and the query resumes with a row-value comparison strictly
after it. Comparing on the pair rather than `created_at` alone is what makes the
boundary unambiguous — many posts share a ledger timestamp, and a
`created_at`-only comparison would drop or repeat all of them.

The cursor is base64url-encoded but **not signed**, and carries no authority:
the endpoint is public and read-only, and the payload is re-validated on the way
back in (`created_at` must be a non-empty string, `id` must be numeric), so a
tampered cursor is rejected rather than trusted. `total` stays the count of
everything matching the filter — not of the remaining suffix — so it does not
shrink on every page.

A malformed cursor is a `400 INVALID_CURSOR`, not a silent restart from the first
page: silently returning page one makes a client that lost its place loop over
the same rows forever.

#### Post deletion semantics (issue #920)

`DELETE /posts/:id` soft-deletes a post. Deletion is a request for a desired end
state — "this post is not visible" — not a transition that may only happen once,
so the outcomes a client can observe are distinguished explicitly:

| Outcome | Status | Body | Retry? |
| --- | --- | --- | --- |
| This call performed the deletion | `200` | `{ "id": "…", "deleted": true }` | — |
| The post was already deleted | `200` | `{ "id": "…", "deleted": false }` | Safe; retrying is a no-op |
| No such post ever existed | `404` | `{ "error": …, "code": "NOT_FOUND" }` | Pointless; do not retry |

Telling "already deleted" apart from "never existed" is the whole point: the
store matches on `deleted_at IS NULL`, so a blind `404` would be returned for
both and an idempotent retry would look like a failure.

### Search

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/v1/search/posts` | Legacy post-only search. |
| GET | `/api/v1/search?q=<term>&type=<entities>&limit=<n>&offset=<n>` | Ranked multi-entity search. |
| GET | `/api/v1/search/facets?q=<term>` | Per-entity match counts. |
| GET | `/api/v1/search/cache` | Operator view of the search response cache. |

#### Query validation and whitespace normalization (BE-26 / BE-28)

All search queries pass through `normalizeQuery` before validation or execution:

1. Leading and trailing whitespace is trimmed.
2. Internal runs of whitespace (spaces, tabs, newlines) are collapsed to a
   single space.

So `"  foo   bar  "` and `"foo bar"` execute the same query and share the same
cache entry. Normalization is applied **before** the length check, so trailing
padding cannot be used to bypass the cap.

After normalization:

- An empty or whitespace-only query is rejected with `400 INVALID_QUERY`.
- A normalized query longer than **200 characters** is rejected with `400 QUERY_TOO_LONG`.
- Boundary: a 200-character query is accepted; a 201-character query is rejected.

#### Bounded search result payload size (BE-29)

- `limit` default **20**, max **100**; a value above 100 is `400 LIMIT_EXCEEDED`.
- `offset` default 0, max 10 000; above max is `400 OFFSET_EXCEEDED`.

These bounds are enforced in the route handler before the store is called, so
an oversized `limit` cannot be used to pull the whole search index through the
cache in one request.

Response:

```json
{ "hits": [ … ], "total": 0, "limit": 20, "offset": 0, "has_more": false, "normalized_query": "…" }
```

Each hit: `{ entity, id, title, snippet, score, attributes }`.

Errors: `400 INVALID_QUERY`, `400 QUERY_TOO_LONG`, `400 LIMIT_EXCEEDED`,
`400 INVALID_LIMIT`, `400 INVALID_OFFSET`, `400 OFFSET_EXCEEDED`,
`400 INVALID_SEARCH_TYPE`, `500 SERIALIZATION_FAILED`.

### Follows

An account cannot follow itself. The rule is enforced in the **write path**
(`handleFollow`), not only where a follow is read back, so a self-follow is
refused with no database call and leaves no state behind (issue #930). A
self-follow is a meaningless edge: it inflates both the follower and the
following count of one account while the edge is invisible in either list,
because a client filters `x !== self`. Comparing the *canonical* addresses means
a contract emitting `GABC…` and an API caller sending `gabc…` cannot slip a
self-follow past each other.

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
| GET | `/api/v1/pools/:id/liquidity` | Liquidity view for one pool. |
| GET | `/api/v1/pools/:id/membership/:address` | Membership check. |
| GET | `/api/v1/pools/liquidity` | Whole-system liquidity summary. |

Each pool is serialized with optional `token_name`, `token_symbol`,
`token_decimals`; when metadata lookups fail the values fall back to
`"unknown"`, `"UNK"`, `7`.

#### Not-found contract (BE-25)

All pool routes that accept a pool `:id` share one consistent not-found response:

```json
{ "error": "Pool not found", "code": "NOT_FOUND" }
```

with HTTP status `404`. The body contains **exactly** `error` and `code` — no
extra keys. This applies uniformly to:

- `GET /pools/:id`
- `GET /pools/:id/liquidity`
- `GET /pools/:id/membership/:address`

A pool that exists but has a zero balance returns `200` from the liquidity
endpoint with `active: false` — "no balance" is a valid state, not a missing
pool. Only a pool that does not exist at all is a `404`.

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

A middleware reads `X-Correlation-Id` (or generates one), stores it on
`req.correlationId`, and echoes it in the `X-Correlation-Id` response header and
HTTP error log line. It is not included in the error body.

### Rate limiting

When `ENABLE_RATE_LIMITING !== "false"`, an `express-rate-limit` middleware covers
the `/api` prefix (including `/api/v1`). Defaults: 60s window, 100 requests per IP.
Exceeding it returns `429` with a `Retry-After` header and body
`{ "error": "Too many requests, please try again later.", "code": "RATE_LIMIT_EXCEEDED" }`.

See the "Known gaps" section of [`architecture.md`](./architecture.md): the
`RATE_LIMIT_*` environment variables are not currently wired to this limiter, and
the imported per-address limiter is not mounted.

### Wallet signature proofs (issue #954)

Routes guarded by `walletSignatureMiddleware` require a signed proof in the
`x-wallet-address`, `x-wallet-signature`, `x-wallet-timestamp` (Unix ms) and
`x-wallet-nonce` headers. The timestamp must be fresh:

- A proof older than the validity window (default 5 minutes, `windowMs`) is rejected
  with `401 WALLET_PROOF_EXPIRED`.
- A proof dated in the future by more than the clock-skew allowance (default 30
  seconds, `futureSkewMs`) is rejected with `401 WALLET_PROOF_FUTURE`.
- A non-numeric timestamp is `400 WALLET_TIMESTAMP_INVALID`.

Replayed nonces are rejected with `401 WALLET_NONCE_REUSED` (see
[`architecture.md`](./architecture.md)).

### Likes on deleted or missing posts (issue #933)

Likes are ingested from chain events, not from a REST route, but the observable
contract is the same one `GET /api/v1/posts/:id` publishes: `like_count` on a
post counts likes that the post can actually hold.

- A `like` delivery for a post that does not exist is dropped: no `likes` row is
  created and the post's `like_count` is unchanged.
- A `like` delivery for a soft-deleted post (`deleted_at` set) is dropped the
  same way — deleting a post never leaves it able to gain new likes.
- Both rejections are logged as warnings (`Like rejected: …`) and the delivery
  completes successfully, so a bad delivery does not dead-letter the stream.

### Errors

All errors use the same exact body shape, including route validation failures,
rate limits, the API 404 catch-all, and errors handled by the global middleware:

```json
{ "error": "Profile not found", "code": "NOT_FOUND" }
```

The body contains exactly `error` and `code`; status remains the HTTP status
listed below. Internal exception messages and arbitrary `details` are not
returned. Use `X-Correlation-Id` to match a response to server-side diagnostics.

| Status | Code | Source |
| --- | --- | --- |
| 400 | `MALFORMED_JSON` | `express.json()` syntax error |
| 400 | `INVALID_QUERY` / `LIMIT_EXCEEDED` / `QUERY_TOO_LONG` | Route parameter validation |
| 400 | `INVALID_ADDRESS` / `INVALID_ID` / `INVALID_CURSOR` | Route parameter validation (issue #665) |
| 400 | `INVALID_LIMIT` / `INVALID_OFFSET` / `OFFSET_EXCEEDED` / `INVALID_SEARCH_TYPE` | Search parameter validation |
| 401 | `UNAUTHORIZED` | Debug token mismatch |
| 404 | `NOT_FOUND` | Route-level or 404 catch-all |
| 422 | `INVALID_THRESHOLD` | Pool threshold validation |
| 429 | `RATE_LIMIT_EXCEEDED` | Rate limiter |
| 500 | `INTERNAL_ERROR` | Unhandled error |
| 500 | `SERIALIZATION_FAILED` | Search response serialization failure |
| 503 | `DATABASE_UNAVAILABLE` | Database error detected |
| 503 | `REQUEST_TIMEOUT` | Request exceeded `REQUEST_TIMEOUT_MS` |
| 503 | `DEBUG_DISABLED` | `DEBUG_TOKEN` not set |

## OpenAPI

`Backend/openapi.yaml` (OpenAPI 3.1) documents the six core v1 read endpoints:
`/profiles/{address}`, `/posts`, `/posts/{id}`,
`/follows/{address}/followers`, `/follows/{address}/following`, `/pools/{id}`.
It does **not** currently cover `/health`, `/version`, `/search/posts`,
`/debug/snapshot`, the `/pools` list, or the version prefix.

### Follow pagination cursor behavior (issue #929)

The `/follows/:address/followers` and `/follows/:address/following` endpoints
support both offset-based and cursor-based pagination:

- `cursor` is optional. When present, it is treated as an opaque key (typically
  the last wallet address returned in the previous page).
- For cursor-based responses, `next_offset` and `prev_offset` are `null`; the
  caller advances by passing the last element of `followers`/`following` as the
  next `cursor`.
- `has_more` is `true` if the number of items returned equals the requested
  `limit`, indicating there may be more results after the returned page;
  otherwise `false`. The `total` count is still returned for informational
  purposes.
- Cursor and offset are mutually exclusive in effect: when `cursor` is supplied,
  the keyset path is used and the `offset` parameter in the response reflects
  the requested value but navigation uses the cursor (not offsets). Errors for
  invalid cursors follow `400 INVALID_CURSOR`.
