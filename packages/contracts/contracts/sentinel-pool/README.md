# `sentinel-pool`

Weighted quorum, tie, and abstention resolution for `SentinelPool`.

Implements **CT-015** (define quorum and ties) only. The rest of
`SentinelPool` — staking, the `stake` / `vote` / `unstake` entry points,
on-chain storage, and slashing (all described in the workspace-level
`packages/contracts/README.md`) — is not implemented here and belongs to
future, not-yet-filed issues.

## What is here, and what is not

| Concern | Owns | State |
|---|---|---|
| Quorum denominator (total pool weight vs. participating weight) | `resolve()` | **This crate** |
| Tie resolution | `resolve()` | **This crate** |
| Abstention semantics | `resolve()` | **This crate** |
| Staking, `stake`/`vote`/`unstake`, storage layout | — | Not implemented |
| Slashing | — | Not implemented |
| Cross-contract calls into `FlowRewards` | — | Not implemented |

`resolve()` is a plain function: it takes the votes cast on a submission and
the pool's total weight as arguments, and returns a `Resolution`. It reads
and writes no contract state, and has no dependency on `soroban-sdk` — see
the module docs in `src/lib.rs` for why, and for the full rationale behind
each rule. The short version:

- **Quorum is measured against the whole pool's staked weight**, not just
  the weight of whoever voted — otherwise a small, fast-moving minority
  could satisfy "quorum" against itself.
- **Ties resolve to `Rejected`** (this includes the `0`-`Approve`-weight,
  `0`-`Reject`-weight case where everyone abstains) — a submission needs an
  actual majority in favor, not just the absence of a majority against.
- **Abstentions count toward reaching quorum but not toward the tally** —
  the standard convention: showing up counts as participation, but doesn't
  push the decision either way.

## Tests

`src/test.rs` exhaustively covers the three areas above plus the defensive
preconditions `resolve()` enforces (duplicate voters, zero-weight votes,
vote weight exceeding the stated pool total, a zero pool total, and
arithmetic overflow) — run with:

```
cargo test -p sentinel-pool
```
