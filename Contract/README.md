# Soroban Contract Workspace (CT-001)

The four Kovara Soroban contracts, as a reproducible Rust Cargo workspace:

| Contract     | Crate                  | Purpose                                                                    |
| ------------ | ---------------------- | -------------------------------------------------------------------------- |
| PriceVault   | `kovara-price-vault`   | Stores raw price submissions keyed by `(country_iso, category, timestamp)` |
| SentinelPool | `kovara-sentinel-pool` | Manages verifier staking, quorum logic, and slashing                       |
| FlowRewards  | `kovara-flow-rewards`  | Releases XLM / Stellar USDC to verified submitters and verifiers           |
| KovaraIndex  | `kovara-index`         | Aggregates verified prices into the daily `KVI` per country                |

## FlowRewards admin transfer

`set_admin(new_admin)` configures the initial admin and cannot replace an
existing one. To rotate the admin, the current admin calls
`propose_admin(admin, new_admin)`. This records a pending proposal without
changing the active admin; only `new_admin` can complete the transfer by
calling `accept_admin(new_admin)`. Acceptance clears the pending proposal and
emits the `admin/changed` event. A later proposal replaces an earlier pending
one, and `admin()` / `pending_admin()` report the current and proposed
addresses.

## PriceVault storage layout

`PriceVault` uses typed Soroban keys rather than concatenated strings:

| Key                                            | Stored value                                                   | Lookup                                                 |
| ---------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------ |
| `DataKey::Price(country, category, timestamp)` | Complete `PriceSubmission`, including price and audit metadata | Single-record reads (`get`, `get_valid`, `get_status`) |
| `DataKey::SubmissionIndex(country, category)`  | `Vec<u64>` of observation timestamps                           | Grouped history and latest-record reads                |
| `DataKey::SubmitterIndex(submitter)`           | `Vec<SubmitterEntry>` — `(country, category, timestamp)`       | Cursor-paginated per-submitter history reads           |

The index timestamps point to `Price` keys in the same country/category scope.
The observation timestamp is `valid_from`; duplicate submissions for the same
composite key leave the original value and index entry unchanged. Keeping
metadata inside `PriceSubmission` makes the record and its metadata atomic.

`SubmitterIndex` is appended in the same transaction as the record and the
group index, so the three views can never disagree about which records exist.

Treat existing key variants and component types as persistent schema. For an
incompatible layout change, add a versioned key and an explicit migration;
never silently repurpose or rename an existing key.

## Access control

The static `registry` decides which identifiers the protocol *understands*. On
top of it, an admin-managed layer decides which of them are *currently
accepted*, so a governance action can narrow or widen acceptance without a
storage migration.

| Key | Stored value | Meaning when empty |
| --- | --- | --- |
| `DataKey::Admin` | `Address` | no admin configured |
| `DataKey::CountryAllowlist` | `Vec<Symbol>` | every registry country accepted |
| `DataKey::CategoryAllowlist` | `Vec<Symbol>` | every registry category accepted |
| `DataKey::Authorizations` | `Vec<Authorization>` | every submitter may write every category |

"Empty means unrestricted" is the property that makes this layer additive: a
contract that never calls `initialize` behaves exactly as it did before, and
clearing any list restores registry-only behaviour.

`Authorization { submitter, categories }` grants a submitter the named
categories; an **empty** `categories` grants every category. An entry that does
not cover a category is a refusal rather than a fall-through to a later entry,
so a narrow grant cannot be widened by a duplicate entry for the same address.

### The allowlists can only narrow

Every entry in an allowlist or authorization policy is validated against the
static registry before it is stored, so the configurable layer can never widen
what the registry accepts. `set_country_allowlist` with `"ZZ"` returns
`Error::InvalidCountry`; the same holds for categories and for categories named
inside an authorization policy.

### Refused before auth and before storage

All three checks run in `submit` **after** the static registry check but
**before** `require_auth` and before any storage access:

```text
registry::is_supported_country  ->  InvalidCountry
registry::is_supported_category ->  InvalidCategory
country_allowed                  ->  CountryNotAllowed
category_allowed                 ->  CategoryNotAllowed
submitter_allowed                ->  SubmitterNotAllowed
payload::validate / guards       ->  schema and arithmetic errors
                                  ---- require_auth ----
                                  storage writes
```

An unauthorised or disallowed call therefore costs the caller a handful of
reads and no auth prompt, and can never leave a partial write behind.

### Reading the policy before submitting

`is_submitter_authorized`, `is_country_allowed` and `is_category_allowed` let a
client check the current policy instead of discovering a refusal by submitting.

## Submission status transitions

```text
Pending ──► Verified
        └─► Rejected
```

`Verified` and `Rejected` are **terminal**. The allowed edges live in
`SubmissionStatus::can_transition_to`, which `set_status` consults — one table,
so the transition rules and the tests that exercise them cannot drift apart.

`can_transition(from, to)` publishes that same table on chain, so a sentinel
daemon can ask "would this transition be accepted?" without submitting a
transaction that is going to be rejected. It returns `false` rather than an
error for any terminal or invalid pair, so it can be used as a plain boolean
gate. Every refusal is the single stable code `Error::InvalidTransition`, and a
refused transition leaves the record byte-for-byte unchanged.

`Error` is `#[repr(u32)]`: its discriminants are part of the contract ABI,
because deployed clients map integer codes back to meanings. They are allocated
**contiguously from 1** and are **append-only**. A new condition gets the next
free number; an existing number is never reused or renumbered, even if the
condition it described is later removed.

## Observing status changes

`set_status` emits `StatusChanged` after the record is written:

| Field | Why it is there |
| --- | --- |
| `country_iso`, `category` | **Topics**, so an indexer can subscribe to the records it cares about without decoding every body |
| `timestamp` | Third component of the record's key — without it an event cannot address a record |
| `prior_status` | Distinguishes "became `Verified`" from "was already `Verified`" |
| `new_status` | The state the record now holds |
| `actor` | The address whose `require_auth` authorised the transition — the part an audit needs |

A refused transition emits nothing, and the record is left unchanged.

## Bounded history queries

`get_submitter_history(submitter, cursor, limit)` pages one submitter's
records.

`cursor` is an **offset into an append-only index**, which is what makes the
pagination stable: new submissions are appended, so an offset already handed
to a caller keeps pointing at the same position. A caller paging through
history never sees a record twice and never skips one because an unrelated
submission landed mid-pagination. An index entry whose record has since been
removed is skipped rather than failing the page.

`limit` must be `1..=MAX_HISTORY_PAGE_SIZE` (50); anything else returns
`Error::InvalidPageSize`. An unbounded history read is a denial-of-service
vector — a submitter with thousands of records would force a caller to pay for
reading all of them in one transaction — so the cap turns that into a bounded,
predictable cost and makes an over-large request fail loudly rather than being
silently truncated.

## Submission windows

A submission's freshness is the half-open window `[valid_from, valid_until)`,
where `valid_until = valid_from + validity_window_secs`.

| `query_ts` | Fresh? |
| --- | --- |
| `< valid_from` | no — not yet valid |
| `>= valid_from` and `< valid_until` | **yes** |
| `>= valid_until` | no — expired |

Lower bound inclusive, upper bound exclusive, so consecutive non-overlapping
windows `[t, t+w)` and `[t+w, t+2w)` never both claim a ledger.

`window_bounds(valid_from, validity_window_secs)` is the one definition of the
window, reachable off-chain and callable by a cross-contract caller before a
transaction is built. Two inputs are refused rather than adjusted:

* a **zero** window — the record would be born already stale, and the
  submitter's stated intent about freshness would be silently discarded;
* an **overflowing** sum — wrapping or saturating `valid_from + window` would
  produce a window nobody asked for, and saturating would read as "valid
  forever" without saying so.

Both return `InvalidWindow`. `valid_from == 0` is separately refused as
`ZeroNotAllowed` by the payload schema, since a zero observation timestamp is
reserved.

## Duplicate submissions

A submission is refused with `Error::DuplicateSubmission` when
`(country_iso, category, valid_from)` is already occupied. The stored record and
its index entries are left untouched.

The refusal is explicit rather than a silent success. A caller that submits and
receives `Ok(())` has no way to distinguish "written" from "ignored", and neither
does an indexer — and the value it wanted to publish is *not* the value in
storage. Failing loudly is the only way the caller learns that.

The key is the record's identity, so neither the validity window nor the
submitter is part of it: varying either does not avoid the collision.

## Freshness reads

| Call | Returns |
| --- | --- |
| `is_fresh(country, category, valid_from, query_ts)` | `bool`; `false` for a missing record |
| `is_valid_at(...)` | Alias, delegating to `is_fresh` — one predicate, one answer |
| `get_fresh_history(country, category, query_ts)` | Only the records fresh at `query_ts` |
| `get_history(country, category)` | Everything, expired records included |

`get_fresh_history` is the read aggregation code should call. `get_history` is
what an audit wants and exactly what an index must not consume: a stale
observation folded into a median is a wrong index value with no error anywhere.

## Admin configuration

`configure_admin(admin)` is one-shot — a second call is refused with
`AdminNotConfigured`, so the authority cannot be handed to a new address as a
side effect of a retried transaction. The lookup has **no fallback to the
caller**: an unconfigured vault cannot be configured by whoever signs the
transaction.

Three policies, all admin-only, all event-emitting:

| Setter | Effect on `submit` | Event |
| --- | --- | --- |
| `set_max_validity_window(actor, Option<u64>)` | A longer window is `WindowTooLong` | `ValidityWindowPolicyUpdated` |
| `set_category_enabled(actor, category, bool)` | A disabled category is `CategoryDisabled` | `CategoryPolicyUpdated` |
| `set_submitter_allowed(actor, submitter, bool)` | A denied submitter is `SubmitterNotAllowed` | `SubmitterPolicyUpdated` |

Each policy is **opt-in and absent-means-unrestricted**: no entry for a category
means enabled, no entry for a submitter means allowed, no bound means any
window. A vault with no admin configured therefore behaves exactly as it did
before these setters existed, and a policy entry disables precisely what it
names and nothing else.

Policy checks run after the pure validation predicates and still **before**
`require_auth` and before any storage access, so a policy-refused submission
costs the caller one failed transaction and leaves storage untouched.

Each event carries `actor` as a topic — the address whose `require_auth`
authorised the change, which is the part an audit needs — and the subject
(category or submitter) as a second topic so a consumer can subscribe to one
category or one submitter without decoding every body.

## KovaraIndex freshness

`set_daily_index` cannot tell whether the observation behind a value was still
fresh when it was written, so an expired price folded into a daily index is
indistinguishable from a correct one.

`set_daily_index_windowed(updater, country, date, value, valid_from, valid_until, query_ts)`
applies the same half-open predicate and stores the window alongside the value:

| Condition | Error |
| --- | --- |
| `date == 0` | `InvalidDate` |
| `valid_until <= valid_from` | `InvalidWindow` |
| `query_ts < valid_from` | `NotYetValid` |
| `query_ts >= valid_until` | `StaleSubmission` |

All four are pure predicates evaluated before `require_auth` and before any
write, so a refused call leaves the previous index value intact. Value and
window are written together, so an entry can never carry a value without the
window that justifies it.

Reads: `is_fresh(valid_from, valid_until, query_ts)` is the pure predicate,
`get_daily_window` returns the window an entry was written under, and
`get_fresh_daily_index` returns the value only while that window is still fresh.
`None` from `get_daily_window` means "written without a window" — which
`get_daily_index` still returns, so the raw record stays auditable.
## The pool-wide aggregate

`total_stake()` is a **stored running total**, seeded to `0` at initialization
and updated by `stake`, `withdraw` and `slash` in the same call that updates the
per-address balance.

Every mutation derives both values with checked arithmetic **before** either
write:

```text
stake:      new_aggregate = total.checked_add(amount)
withdraw:   new_aggregate = total.checked_sub(amount)
slash:      new_aggregate = total.checked_sub(amount)
```

The increment is read once and reused, so the balance and the total come from
one arithmetic step rather than two that could drift. A refused operation moves
neither side.

`the_aggregate_never_disagrees_with_the_balances` states the invariant
explicitly: `total_stake() == balance(a) + balance(b) + ...`. It is checked after
a withdrawal and again after a refused one.

The total saturating against a maximal balance is deliberate, not a bug:
`stake(i128::MAX)` succeeds, and the *next* deposit is refused with
`InvalidStake` because the aggregate would overflow — with the second address's
balance left at `0` rather than wrapped negative.

## The emergency pause

`pause` stops value movement without freezing the pool's configuration.

| Call | Paused | Not paused |
| --- | --- | --- |
| `stake` | `PoolPaused` | succeeds |
| `withdraw` | `PoolPaused` | succeeds |
| `slash` | `PoolPaused` | succeeds |
| `deregister` | `PoolPaused` | succeeds |
| `pause` | succeeds (idempotent) | succeeds |
| `unpause` | succeeds | refused — nothing to undo |
| `set_threshold`, `set_min_stake` | succeeds | succeeds |
| `set_governance`, `set_challenge_period` | succeeds | succeeds |
| every read | succeeds | succeeds |

Value movement stops; configuration and the emergency controls do not. A pause
that also froze `unpause` or the configuration setters would be a one-way trip
for the operator dealing with the incident.

`PauseChangedEvent` carries the pool-wide aggregate, so an indexer can see the
pause without a follow-up read.

Pausing is held by **governance**, not by the admin — stopping the pool from
moving value is an operational power, not a configuration one. `set_governance`
assigns it. Until that call is made, `pause` and `unpause` are refused with
`PauseNotAuthorized`; there is **no fallback to the caller**.

## Leaving the set

A registered sentinel's withdrawal may take the balance down to `min_stake` and
no further. Taking it to zero is what "leaving the set" means, and it is a
separate lifecycle step so that the reason is recorded:

```text
stake ──► registered ──deregister──► deregistered ──wait lock + challenge──► exited
```

* `deregister(sentinel)` records the ledger and the challenge period in force.
  The stake stays in the pool throughout — deregistering is not a withdrawal, and
  the balance is still there for a slash under review.
* A full exit (`remaining == 0`) requires a recorded deregistration
  (`NotDeregistered` otherwise) and an elapsed challenge period
  (`ChallengePeriodActive` otherwise). The `min_stake` floor does not apply to
  an exit.
* Partial withdrawals by a deregistered sentinel still respect the floor: the
  challenge period gates the *exit*, not ordinary withdrawals, which were always
  available down to the floor.
* `stake` is refused for a deregistered address (`AlreadyDeregistered`). Allowing
  a one-unit top-up during the challenge period would let a sentinel reset the
  window and skip the delay.
* Completing an exit clears the record, so a returning sentinel registers clean
  and a later exit needs its own deregistration and its own challenge period.

### The challenge period is not retroactive

`Deregistration { at, challenge_period }` copies the period that was in force at
deregistration. `set_challenge_period` afterwards cannot cut short a challenge
period that is already running — otherwise shortening it would be a way to
retroactively strip an exit right. `withdrawable_at(sentinel)` reports the
recorded deadline.

The period is bounded by `MAX_CHALLENGE_PERIOD_LEDGERS` (20 000 000) so
`at + period` stays representable in a `u64`; the default is
`DEFAULT_CHALLENGE_PERIOD_LEDGERS` (2 592 000 — thirty days), long enough for a
slash under review to conclude.

## Sentinel eligibility

`is_eligible(sentinel, at_ledger)` answers "would this address count as an
active sentinel at ledger N?" in one read:

1. the balance is at or above `min_stake`;
2. the address is not deregistered;
3. the withdrawal lock has elapsed at `at_ledger`.

The ledger is a parameter so a caller can ask the hypothetical question — "will
this sentinel be eligible at the next halving?" — without waiting for it.
Asking about a past ledger gives that ledger's answer. An unknown address
returns `false`, not an error: "not eligible" is the answer, not a failure.
## Slashing is a governed, reversible process

A slash takes a sentinel's stake immediately, but it is the start of a process
rather than the end of one:

```text
 slash ──► Pending ──appeal──► Pending ──resolve──► Upheld | Reversed
              │                  │
              └──────────────────┘
         appeal only until `appeal_deadline`
```

### Governance authorization

Every slash operation — `slash`, `appeal_slash`, `resolve_slash` — requires the
configured governance address, resolved by `require_governance`:

| Stored `DataKey::Governance` | Caller | Result |
| --- | --- | --- |
| `Some(g)` | `g` | authorized |
| `Some(g)` | anything else | `NotGovernance` |
| absent | anything | `GovernanceNotConfigured` |

There is **no fallback to the caller**. An ungoverned pool cannot be slashed at
all, rather than being governed by whoever happened to sign the transaction.

Governance is deliberately a separate key from `Admin`. Collapsing them would
mean whoever can change `min_stake` can also confiscate stake. `set_governance`
lets the admin rotate it; the old address loses the power on the next ledger.

`initialize` takes `governance` explicitly rather than inferring it from `admin`
— the two may be the same address for a single-operator deployment, but the
contract never *assumes* that.

### Evidence references

`slash` takes a `SlashEvidence { proof_ref, uri, content_hash }`, stored on the
`SlashRecord` and republished on `SlashedEvent`. The three fields answer the
three questions an auditor asks: *which case*, *where is the record*, and *is
this the record I am looking at* — the hash pins the content so a mutable URI
cannot quietly change what the evidence says.

A record with an empty `proof_ref` or an empty `uri` is refused with
`InvalidEvidence`. The stake is taken immediately; a confiscation that cannot be
pointed at its justification cannot be appealed on evidence either.

`proof_ref` is a **data** field on the event, not a topic — it is
high-cardinality, and adding it as a topic would bloat the topic set of a
consumer filtering on "every slash for this reason".

### The appeal window

Each record carries the window in force when the slash was applied:

```text
appeal_deadline = slashed_at + appeal_window
```

An appeal is accepted while `ledger.sequence() <= appeal_deadline` and refused
from the ledger after it with `AppealWindowClosed`.

| Check | Meaning |
| --- | --- |
| `now <= appeal_deadline` | inside the window |
| `now > appeal_deadline` | `AppealWindowClosed` |
| `appeal_window == 0` | `AppealWindowClosed` — a zero window closes the deadline on the ledger the slash was applied |

**The window is copied onto the record, so it is not retroactive.**
`set_appeal_window` afterwards cannot close an appeal a sentinel is already
entitled to file — otherwise shortening the window would be a way to retroactively
strip an open appeal right.

`appeal_window` is bounded by `MAX_APPEAL_WINDOW_LEDGERS` (6 000 000) so the
deadline is representable in a `u64` for every reachable `slashed_at`. The
default is `DEFAULT_APPEAL_WINDOW_LEDGERS` (604 800 — seven days).

An appeal does **not** restore the stake. The slash stands until governance
resolves it; the appeal only marks the record as disputed.

The appellant may be the slashed sentinel or the governance address — the two
parties to the dispute. Anyone else is refused.

### Resolution is terminal and happens exactly once

`resolve_slash(governance, proof_ref, uphold)` upholds or reverses a slash once.
A second call is `AlreadyResolved`, whichever outcome it asks for. Without that
constraint a reversed slash could be reversed again, restoring the same stake
twice.

| `uphold` | Effect |
| --- | --- |
| `true` | Stake stays removed; `restored == 0`; outcome `Upheld` |
| `false` | `amount` added back with `checked_add`; outcome `Reversed` |

A reversal that would overflow `i128` is refused with `InsufficientBalance`
rather than wrapping the balance. The `outcome` check happens before every write,
so a refused resolution leaves both the record and the stake untouched and the
record is never half-resolved.
## The withdrawal lock is a window, not a countdown

A sentinel's lock is stored as one absolute ledger — `staked_at` — and runs
until `unlock_at = staked_at + lock_period`. `unlock_at(env, sentinel)` returns
that ledger, or `None` for an address that has never staked.

### Lock arithmetic is checked

`unlock_at` is derived with `checked_add`. An unrepresentable window returns
`InvalidLockPeriod`; it is never saturated to `u64::MAX`, because a saturated
window reads as "locked forever" without saying so.

`withdraw` compares ledgers directly — `now < unlock_at` — rather than computing
`now - staked_at` and comparing the difference. A saturating subtraction would
silently report "the lock has elapsed" for a window that has not been reached;
the direct comparison is exact at both boundaries.

`lock_period` is additionally bounded by `MAX_LOCK_PERIOD` (1 000 000) at
initialization, so every reachable unlock ledger is representable. The runtime
check is kept anyway: bounding the parameter at configuration time and checking
the arithmetic at use time are different guarantees.

### A top-up never extends a running lock

`stake` leaves `staked_at` untouched while `now < unlock_at`, and sets it to the
current ledger once that window has elapsed.

| Event | `staked_at` becomes |
| --- | --- |
| First deposit | current ledger |
| Top-up **while the lock is running** | unchanged — the window does not move |
| Top-up **at or after expiry** | current ledger — a fresh window |

Both halves of that matter:

* Letting a top-up move the window would let a sentinel push their own unlock
  date out indefinitely by depositing one unit repeatedly — the lock becomes a
  fee rather than a constraint.
* Resetting it unconditionally on every deposit is worse: a top-up landing one
  ledger before expiry would silently extend the lock by the full
  `lock_period`, which is a trap rather than a policy.

`stake` reads the existing start as an `Option`, not `unwrap_or(0)`, so a
deposit that lands on genesis ledger `0` is a real recorded window and not
mistaken for "never staked".

## Slash amounts are bounded before anything is written

`slash` checks three bounds, in order, all before the first write:

| Bound | Error |
| --- | --- |
| `proof_id` is non-empty | `InvalidProofId` |
| `amount > 0` | `InvalidSlashAmount` |
| `amount <= current stake` | `SlashExceedsStake` |
| remainder `>= min_stake` | `StakeBelowMinimum` |

The three amount bounds are distinct conditions with distinct remedies — a
malformed call, an unaffordable one, and one that would de-register the
sentinel — so each gets its own error instead of collapsing into one.

Because the balance map and the proof map are written only after every check
passes, a refused slash leaves **both** the stake and the proof identifier
untouched. An identifier that failed a call is still unused and still usable
exactly once.

## Slash proof identity

Replay protection keys on a caller-supplied `proof_id`, not on
`(sentinel, reason)`.

That pair was not unique in either direction:

* **False rejection.** Two genuinely distinct incidents against the same
  sentinel sharing a reason code (`fraudulent_submission`) collided, and the
  second was refused as a replay of the first.
* **False acceptance.** One incident relabelled with a different reason code
  passed twice.

`proof_id` is a non-empty `String` chosen by the caller and required to be unique
within the pool. `reason` stays a `Symbol` and an event topic for filtering, but
carries no replay semantics.

Uniqueness is global rather than per-sentinel: re-submitting an identifier is
refused identically whether the sentinel, the reason, or both differ. That is the
point — under the old `(sentinel, reason)` key the same case file could be
applied against a second address simply by changing one component of the key.

`slash_proof(proof_id)` returns the stored [`SlashProof`] — sentinel, reason,
amount and ledger — so an auditor holding an identifier can ask the contract
what it was applied to without replaying the event stream.

### Event schema

`SlashedEvent` gains `proof_id`, `remaining` and `slashed_at`. `proof_id` is
deliberately **not** a topic: it is high-cardinality, and adding it as a topic
would bloat the topic set of a consumer subscribed to "every slash for this
reason".
## SentinelPool initialization

`SentinelPool` is only meaningful once it has been configured. Every
state-changing entry point — `stake`, `withdraw`, `set_threshold`,
`set_min_stake` and `slash` — opens by calling `require_initialized`, which
returns `Error::NotInitialized` when `DataKey::Admin` is absent. `is_initialized`
exposes the same fact as a view.

Without that guard the read-path defaults (`min_stake -> 0`,
`lock_period -> 0`) describe a real pool with **no minimum stake and no
withdrawal lock**: anyone could stake nothing, and `withdraw` would behave as
though no lock existed. The guard converts that accidental configuration into an
explicit, stable error.

`initialize` is all-or-nothing. Parameters are validated in a fixed order, each
step a pure predicate over the arguments, and all of them run **before**
`require_auth` and before the first write:

| Parameter | Rule | Error |
| --- | --- | --- |
| `min_stake` | `> 0` | `InvalidStake` |
| `lock_period` | `1 <= n <= MAX_LOCK_PERIOD` | `InvalidLockPeriod` |
| `threshold` | `> 0` | `InvalidThreshold` |

A refused call therefore leaves **no** partial configuration behind:
`is_initialized` keeps reporting `false`, `min_stake` and `threshold` keep
reporting `0`, and a later corrected call still succeeds. A second successful
initialization is refused with `Unauthorized`.

`MAX_LOCK_PERIOD` (1 000 000 ledgers) exists because the lock is measured in
`ledger.sequence()`, a `u32`. A lock that could not elapse would freeze every
sentinel's stake permanently, so the parameter is bounded at configuration time
rather than trusted.

## SentinelPool authorization

`set_threshold`, `set_min_stake` and `slash` all resolve the admin the same way,
through `require_admin`:

```text
stored Admin == caller  ->  authorized
anything else           ->  Unauthorized
```

The stored value is **mandatory**. The previous lookup fell back to
`unwrap_or_else(|| caller.clone())`, so on an unconfigured pool the comparison
`admin != stored_admin` was always false and whichever address authorized the
call became the admin by default. Requiring a stored admin removes that path;
combined with the initialization guard, an unconfigured pool cannot be
configured *or* governed by anyone.

## SentinelPool checked arithmetic

| Operation | Guard | Failure |
| --- | --- | --- |
| `stake` balance | `checked_add` | `InvalidStake` |
| `withdraw` remainder | `checked_sub` | `InsufficientBalance` |
| `slash` remainder | `checked_sub` | `InsufficientBalance` |

All three run **before** the balance map is written, so an overflow or an
excessive withdrawal leaves the sentinel's stake exactly as it was — no partial
write, no event. `stake(&sentinel, &i128::MAX)` therefore succeeds once (the
balance *is* `i128::MAX`) and is refused on replay, because the second call is
the one that would overflow.
## The `min_stake` floor is a registration rule

An address holding a non-zero stake is a **registered sentinel**, and a
registered sentinel is expected to keep at least `min_stake` deposited for as
long as it stays registered. `stake` enforces the floor on the way in and
`withdraw` enforces it on the way out, so it holds at every balance the pool
ever exposes — including the very first one, because `stake` compares the
*resulting* balance rather than the increment.

The rule, stated plainly:

| Resulting balance | `stake` / `withdraw` |
| --- | --- |
| `== min_stake` | accepted |
| `> min_stake` | accepted |
| `< min_stake` | `StakeBelowMinimum` |
| `0` | `StakeBelowMinimum` |

So a **partial withdrawal may take a sentinel down to exactly `min_stake` and no
further**. Withdrawing the whole balance is not available through `withdraw`,
because a zero balance would silently de-register the address — and the pool has
no separate step recording *why* an address stopped being a sentinel. Leaving
the set is a lifecycle event with its own rules, not an arithmetic side effect
of an amount.

Raising `min_stake` above balances that already exist does not retroactively
invalidate them, and it does not trap those sentinels: every withdrawal they
attempt is refused with `StakeBelowMinimum` and their balance is preserved
intact.

## SentinelPool withdrawal accounting

`withdraw` runs its checks in a fixed order and writes the balance map only once
all of them pass:

| # | Check | Error |
| --- | --- | --- |
| 1 | `amount > 0` | `InvalidStake` |
| 2 | `amount <= balance` | `InsufficientBalance` |
| 3 | lock elapsed | `LockPeriodActive` |
| 4 | `balance - amount` via `checked_sub` | `InsufficientBalance` |
| 5 | `balance - amount >= min_stake` | `StakeBelowMinimum` |

Step 2 makes step 4 unreachable in practice; `checked_sub` is kept anyway so
that `remaining` is derived by checked arithmetic on the line that consumes it.
Because nothing is written until step 5 succeeds, **every** rejection — invalid
amount, excessive amount, active lock, below-minimum remainder — leaves the
sentinel's balance byte-for-byte unchanged and emits no event.

## SentinelPool stake queries

All three are views: they read storage and the ledger, write nothing, and emit
nothing, so an indexer can poll them without perturbing the pool.

| Call | Returns |
| --- | --- |
| `balance(sentinel)` | The deposited amount |
| `staked_at(sentinel)` | Ledger sequence number the current lock started on |
| `stake_of(sentinel)` | `SentinelStake { amount, staked_at, unlock_at, unlocked }` |
| `total_active_stake()` | Sum of every deposited amount |

`stake_of` is total: an address that never staked reports the zero record
(`amount == 0`, `staked_at == 0`, `unlocked == true`) rather than failing, so a
caller enumerating candidates never has to distinguish "not a sentinel yet" from
"the read failed". `unlock_at` saturates rather than overflowing — it is a
reporting value, and "the unlock ledger is unreachable" is more useful to a
caller than a failed read.

`total_active_stake` is **computed at read time**, not stored. A cached running
total is one forgotten update away from disagreeing with the per-address
balances it is supposed to summarize; folding the map costs one pass, which is
the same order as any governance read that must see every sentinel. Sums
saturate at `i128::MAX` instead of wrapping.

## Stake events

`StakedEvent` carries the resulting balance and the ledger the lock runs from:

| Field | Why it is there |
| --- | --- |
| `sentinel` | **Topic** — who deposited |
| `amount` | The increment, which alone does not reconstruct the position |
| `total` | The balance *after* this deposit; two equal deposits against different starting balances are very different events |
| `staked_at` | The ledger the deposit landed on, and therefore where the withdrawal lock starts |

`amount` and `total` are both needed by an indexer that rebuilds balances from
the event stream rather than by polling `balance`. The ledger sequence is read
once inside `stake` and reused for both `StakedAt` storage and the event, so the
stored timestamp and the published one cannot disagree.

## Prerequisites

- Rust **stable** (1.84+ recommended; the Soroban environment supports 1.82+)
- The appropriate WebAssembly build target:
  - Rust 1.82+: `rustup target add wasm32v1-none`
  - Rust 1.81 or earlier: `rustup target add wasm32-unknown-unknown`
- `soroban-cli` (for deploying, optional for plain builds):
  ```sh
  cargo install --locked stellar-cli
  ```

## Build

Build the whole workspace, passing the target matching your toolchain (the
`.cargo/config.toml` sets the matching linker flags automatically):

```sh
# Rust 1.82+
cargo build --release --target wasm32v1-none

# Rust 1.81 or earlier
cargo build --release --target wasm32-unknown-unknown
```

Build a single contract:

```sh
cargo build --release --target wasm32v1-none -p kovara-index
```

The `.wasm` artifacts land in `target/<target>/release/`.

For the first-time dependency resolution / reproducible lockfile:

```sh
cargo generate-lockfile
# after a lockfile is present, `--locked` bakes reproducibility in:
cargo build --release --locked --target wasm32v1-none
```

## Test

```sh
cargo test
```

## Lint / format

```sh
cargo fmt --check
cargo clippy --release --target wasm32v1-none -- -D warnings
```

## Deploy (Testnet)

With `soroban-cli` installed (which selects the matching build target for you):

```sh
soroban contract build
soroban contract deploy \
  --wasm target/wasm32v1-none/release/kovara_index.wasm \
  --network testnet
```

Use the `kovara-index` contract address reported by the command as the
`CONTRACT_ID` for the indexer backend.
