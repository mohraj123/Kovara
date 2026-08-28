# `kovara-index`

Daily Kōvara Value Index (KVI) records — one per country, per day.

Implements the full **CT-030..CT-037** series for the daily index:

| Issue | Owns | State |
|---|---|---|
| CT-030 | Daily storage: one record per country/day, plus `latest` and range queries | **This crate** |
| CT-031 | KVI rounding rules for `value` | **This crate** |
| CT-032 | Deterministic aggregation producing `value` | **This crate** |
| CT-033 | Rejection of duplicate index updates | **This crate** |
| CT-034 | Who may update, and how many must agree | **This crate** |
| CT-035 | The `DailyIndexUpdated` event and its fields | **This crate** |
| CT-036 | Schema versioning and rejection of incompatible data | **This crate** |
| CT-037 | Admin transfer and recovery | **This crate** |

## Storage and queries (CT-030)

An authorized update stores **one record per country per day** — the record is
keyed by `(schema_version, country, date)` — and emits the `DailyIndexUpdated`
event (CT-035). Three query entrypoints read it back:

- `get_daily_index(country, date)` — a single day;
- `latest_daily_index(country)` — the most recent day, via the per-country
  latest-date index that CT-033 also uses, so it is one read, not a scan;
- `daily_index_history(country, from, to)` — the days in `[from, to]`,
  ascending, bounded by `MAX_HISTORY_WINDOW` (ten years) so a caller cannot
  turn the query into an unbounded loop. An inverted range is rejected.

## The value (CT-031)

`value` is a signed fixed-point integer in **`KVI_SCALE` = 10,000** units:
`value / 10,000` is the human-readable index.

- **Scale** — `KVI_SCALE`, one scale everywhere, so two implementations of
  the aggregation produce numbers a consumer can compare.
- **Rounding** — the single rounding rule is *half away from zero*
  (`5 / 2 -> 3`, `-5 / 2 -> -3`). It is applied wherever a division can
  produce a fractional result (the even-count median average). It is
  symmetric and never biased toward either direction.
- **Overflow** — values outside `±KVI_VALUE_MAX` (10^18) are rejected with
  `ValueOutOfRange` rather than stored. The bound keeps every arithmetic step
  in the contract far inside `i128`, so nothing can wrap silently.
- **Missing basket** — a record without a basket (`basket_version == 0`) is
  rejected, and a day that was never finalized simply reads as `None`: the
  contract never writes a zero as a stand-in for "no data".
- **Baseline** — the KVI is normalized so parity with the reference period
  reads as **`KVI_BASELINE` = 100 * `KVI_SCALE`** (100.0000). The contract
  stores absolute values and does not re-normalize; the constant pins what
  "parity with the baseline" means for every consumer.

## Deterministic aggregation (CT-032)

`compute_daily_index(observations)` produces the daily value from raw
`Observation { value, weight }` pairs as a **weighted, 10%-trimmed median**.
It is pure and stateless, so any sentinel can call it to verify a submitted
aggregate, and identical inputs always yield the identical number:

1. **Trim** — drop the lowest and highest `len * 10 / 100` observations
   (floored), so a single wild value at either end changes nothing.
2. **Sort** — ascending by value only; equal values are interchangeable, so
   the result depends on the multiset of `(value, weight)` pairs, never on
   input order.
3. **Weighted median** — the first value whose cumulative weight exceeds
   half the total. When cumulative weight lands **exactly on half**, the two
   straddling values are averaged and rounded half away from zero (CT-031).

`set_aggregated_index(...)` computes the value with the same function, then
stores it and emits the event exactly as `set_daily_index` would, returning
 the computed value. An observation with zero weight is rejected.

## Immutable history (CT-033)

Finalized history is immutable and strictly forward:

- **Duplicates** — a `(country, date)` that already has a record is rejected
  with `IndexAlreadyFinalized`, so replaying an update (even with a different
  value) can never overwrite a finalized day.
- **Out-of-order** — a `date` at or before the country's latest finalized
  date is rejected with `OutOfOrderUpdate`. History moves forward only; a
  missed day is simply a day with no index and cannot be backfilled later.

Both checks run in the same write path as the record itself, so the guard and
 the data cannot diverge. A rejected update emits no event and stores nothing.

## Storage versioning policy (CT-036)

Two mechanisms doing two different jobs.

**The schema version is recorded at initialization**, and every operation
checks it. A deployment initialized under one schema and then handed code
expecting another fails with `IncompatibleSchema` rather than reading records
it does not understand. Reads are guarded as well as writes — a bad read is
the quieter failure, because it returns a plausible wrong number instead of an
error.

**Record keys embed the schema version.** `DailyIndex(1, "NG", d)` and
`DailyIndex(2, "NG", d)` are different entries, so two schemas' data occupy
disjoint keyspaces.

That second part is what makes a future migration possible: v2 records can be
written alongside v1 rather than on top, so a migration is resumable and a
failed one leaves the original data intact.

### Changing the schema

1. Change the stored shape or the meaning of a key.
2. Bump `SCHEMA_VERSION` **in the same commit**.
3. Every existing deployment now rejects all operations until migrated. That
   is the intended outcome — the alternative is decoding a v1 record as
   though it were v2.

Executing a migration is **out of scope here.** CT-036 asks for versioning and
rejection, not a migration engine; the versioned keyspace is the precondition
for one. A migration entry point belongs in its own issue, and it should read
under the old schema version and write under the new one.

### Inspecting a deployment

```
deployed_schema_version() -> Option<u32>   what this deployment was initialized at
expected_schema_version() -> u32           what this build understands
is_schema_compatible()    -> bool          whether they agree
```

Deployment tooling should call these rather than provoking an error to find
out.

## Authorization (CT-034)

A daily aggregate moves a number the whole system trusts, so it is not
something one key should be able to do alone. `set_daily_index` takes a list
of signers and requires:

- every signer authorizes the call itself;
- every signer is on the sentinel roster;
- no address appears twice;
- at least `threshold` signers are present.

The duplicate check is what makes the threshold mean anything. Without it one
sentinel could pass the same address N times and satisfy an N-of-M policy
alone. There is a test for exactly that.

The first signer is the submitter, and is what lands in the record's and the
event's `updater` field.

### Rotation

`set_sentinels(admin, sentinels, threshold)` replaces the roster and the
threshold **in one call**. Doing it as separate add/remove steps would leave
intermediate states where the threshold exceeds the roster, or where a removed
sentinel can still sign alongside its replacement.

A threshold of zero would authorize anyone; a threshold above the roster size
could never be met and would freeze the index. Both are rejected, as are an
empty roster and a duplicated address within one.

Before any roster exists, every update fails with `SentinelsNotConfigured` —
it fails closed rather than falling back to "anyone may update".

## Admin transfer and recovery (CT-037)

Ownership changes are where administrative control gets stranded, so there are
two paths and they cover different failures.

### Two-step transfer

`propose_admin_transfer` → `accept_admin_transfer`. Proposing does not move
control; the recipient must accept, which proves the address is real and
controlled. A single-step transfer to a mistyped or unspendable address
strands the contract permanently.

Proposals carry a required expiry, so a forgotten one cannot be accepted years
later by whoever ends up holding that key. The sitting admin can cancel at any
time, and a new proposal replaces the previous one.

### Recovery

If the admin key is simply gone, no transfer can be proposed at all. A
**sentinel quorum** can then propose a recovery, which becomes executable only
after `RECOVERY_DELAY_LEDGERS` — roughly a day.

That delay is the entire safety mechanism: it is the window in which a
still-live administrator can veto a recovery they did not ask for, and
vetoing is itself proof they still hold the key. Without the delay, a
compromised sentinel quorum could seize a perfectly healthy contract.

`execute_admin_recovery` is deliberately callable by anyone. Requiring the
incoming administrator to call it would reintroduce the liveness assumption
the recovery path exists to remove, and the outcome was already fixed when the
quorum proposed it.

The two paths clear each other: accepting a transfer cancels any pending
recovery (control demonstrably just moved), and executing a recovery cancels
any pending transfer (the displaced admin's authority is gone).

## The daily index event (CT-035)

`DailyIndexUpdated` carries every field the issue requires — country, date,
value, basket version, source period, and updater — so a consumer can act on
the event alone without a follow-up read.

`country` and `date` are **topics**, because those are the two dimensions an
indexer filters on. Everything else is in the data section.

Two fields exist because consumers could not otherwise interpret the number:

- **`basket_version`** — without it, a consumer cannot tell a real movement in
  prices from a change in what is being measured. Zero is rejected, since zero
  is what "no basket recorded" would look like and that is precisely the
  ambiguity this removes.
- **`source_period_start` / `source_period_end`** — the window the underlying
  observations cover, which is not the same as the day the index is filed
  under.

`schema_version` rides along too, so a consumer can tell which storage schema
produced a record — which matters while a migration is in progress and both
schemas are briefly live.

## Build and test

```bash
cd packages/contracts

cargo test -p kovara-index                       # 97 tests
cargo build --target wasm32v1-none --release     # -> target/wasm32v1-none/release/kovara_index.wasm
```

Use **`wasm32v1-none`**, not `wasm32-unknown-unknown`. Rust 1.82+ enables
reference-types and multi-value on the latter, which the Soroban environment
does not support; the build fails with an explicit error saying so.
