# Maintainer note — issues #695, #696, #697, #698

`Contract/contracts/price-vault/src/lib.rs` does not parse on `main`. All four
issues assigned against the price vault require unit tests on that crate, so none
of them can be delivered until it compiles.

This note records the diagnosis, the three unambiguous repairs applied in this
branch, the damage that remains, and why the remainder needs an owner decision
rather than a guess.

## Reproduction

Verified at `main` = `20d7bb5` with `cargo 1.98.1`:

```
$ cd Contract && cargo check -p kovara-price-vault
error: unexpected closing delimiter: `}`
   --> contracts/price-vault/src/lib.rs:641:1
    |
619 | impl PriceSubmission {
    |                      - this opening brace...
629 | }
    |  - ...matches this closing brace
641 | }
    |  ^ unexpected closing delimiter
```

The same file content was fetched directly from the GitHub API for
`mohraj123/Kovara` and is byte-identical to a fresh clone, so this is the state of
`main` and not a local artifact.

## Root cause: CI never compiles the contracts

`.github/workflows/ci.yml` runs `pnpm install` and the Turbo/Jest test matrix
only. There is no `cargo build`, `cargo check`, `cargo test`, or
`stellar contract build` step anywhere in it. The Rust crates under `Contract/`
are therefore never compiled by CI, which is how a file that cannot be parsed was
merged to `main` with a green **CI** run.

This is the finding most worth acting on: without a `cargo` step, the next
mis-merge lands the same way.

## Damage

The file is the result of at least two branches being merged into the same
regions without reconciling them. Three defects were unambiguous and are fixed
here; a fourth is not.

### Fixed — 1. Orphaned `Error` variant inside `impl SubmissionStatus`

`InvalidRange = 2,` sat between `is_terminal`'s closing brace and the `impl`
block's closing brace — enum-variant syntax inside an `impl`.

It is a real variant, not dead text: `get_history_range` returns
`Err(Error::InvalidRange)` and a test asserts it. Moved into `Error`.

**Deliberate change:** appended as `InvalidRange = 9`, not `2`. Discriminant `2`
is already `MissingRequiredField`, and `#[contracterror]` discriminants are part
of the contract ABI — renumbering an existing variant would silently change the
code every deployed client already maps.

### Fixed — 2. Orphaned `PriceSubmission` fields

`timestamp: u64` and `status: SubmissionStatus` were left after the struct and its
`impl` block had both closed, along with a duplicated doc comment on the struct.

Both are real fields, which the file proves against itself: `submit` constructs
`PriceSubmission { submitter, country_iso, category, value, valid_from,
valid_until, timestamp, status }`, `set_status` reads and writes `.status`, and
tests assert `got.timestamp` and `record.status`. The intended shape was therefore
recoverable from usage rather than guessed. Folded back into the struct.

### Fixed — 3. Duplicated struct doc comment

Two descriptions of `PriceSubmission` were concatenated. Kept the one describing
the validity window, which matches the fields that survived.

### Not fixed — 4. Interleaved and unclosed test modules

After the three repairs above, the crate still fails:

```
error: this file contains an unclosed delimiter
    --> contracts/price-vault/src/lib.rs:2707:3
 896 | mod tests {                                        - unclosed delimiter
1392 | mod tests {                                        - unclosed delimiter
1429 |     fn submit_records_pending_status() {           - unclosed delimiter
1686 |     fn get_status_returns_none_for_missing_...() { - unclosed delimiter
1905 |     fn get_status_returns_current_state_...() {    - might not be properly closed
2061 | }                                                  - ...matches this but different indentation
```

There are **four** `#[cfg(test)] mod tests` blocks (lines 896, 1392, 2066, 2362)
interleaved with `#[contractimpl] impl PriceVault` entry points — `get_status`,
`get_history`, `get_history_range`, `get_latest`, `safe_add`, `safe_mul` and
`validate_submit_payload` all appear *after* the first test module opens. Repairing
this means deciding which of the four modules owns each of ~40 tests and where the
`impl` block is meant to end, across roughly 1,800 lines contributed by several
different PRs.

That is a reconstruction of intent, not a mechanical fix, so it is left to the
owners.

## Recommended next steps

1. **Add a `cargo` job to CI.** A `cargo check --workspace` step under
   `Contract/` is enough to stop this class of breakage, and would have caught it
   here. Consider `cargo test --workspace` once the crate parses again.
2. **Decide repair vs revert for the remaining damage.** Reverting
   `price-vault/src/lib.rs` to the last commit where `cargo check` passed and
   re-applying the affected PRs on top is likely safer and faster than
   reconstructing the interleaving by hand. `git log --oneline -- Contract/contracts/price-vault/src/lib.rs`
   plus a `cargo check` bisect will identify that commit.
3. **Then reopen #695–#698.** Once the crate compiles, the four issues are
   straightforward against the existing surface, which already has most of the
   scaffolding:

   | Issue | Existing surface | Gap |
   |---|---|---|
   | #696 submission entry logic | `submit` exists and writes `DataKey::Price` plus `DataKey::SubmissionIndex` | verify failed writes leave state unchanged |
   | #695 country/category validation | `payload::validate` with `Constraint`/`FieldKind` exists | no known-country or known-category constraint yet |
   | #697 duplicate same-day entries | `submit` already returns early when the key exists | returns `Ok(())` silently rather than an explicit error |
   | #698 stale record expiration | `valid_from`/`valid_until`, `is_valid_at`, `get_valid` all exist | confirm stale records are excluded from index computation |

   Note #697 in particular: the current early return on a duplicate key is
   indistinguishable from a successful write by the caller, which is the opposite
   of that issue's "return an explicit failure code or error" criterion.

## Scope of this branch

Three parser-level repairs to `Contract/contracts/price-vault/src/lib.rs` and this
note. No behaviour is changed: no entry point is added or removed, no storage key
or validation rule is altered, and the `PriceSubmission` field set is exactly the
one `submit` already constructs. The crate still does not compile, so this is a
**draft** — it reduces the problem rather than resolving it.
