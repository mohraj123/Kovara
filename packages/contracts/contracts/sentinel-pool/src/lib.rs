//! `sentinel-pool` — weighted quorum, tie, and abstention semantics for
//! `SentinelPool` (CT-015).
//!
//! `SentinelPool` (per the workspace README) lets verifiers stake to gain
//! voting weight and cast `Approve` / `Reject` votes on a submission before
//! it resolves. What was previously **unspecified** — and is the entire
//! scope of this issue — is: what counts in the quorum denominator, how a
//! tie resolves, and what an abstention does to both. This crate answers
//! those three questions with one function, [`resolve`], and pins the
//! answer down with an exhaustive test suite in `src/test.rs`.
//!
//! | Concern | Answered here | Left to a future issue |
//! |---|---|---|
//! | Quorum denominator | ✅ total pool weight, not just voters | — |
//! | Tie handling | ✅ ties resolve to `Rejected` | — |
//! | Abstention semantics | ✅ counts for quorum, not for the tally | — |
//! | Staking / vote casting / storage | Not implemented | Contract-wiring issue |
//! | Slashing | Not implemented | Contract-wiring issue |
//!
//! Deliberately **not implemented here**: staking, the `stake` / `vote` /
//! `unstake` entry points, storage layout, and slashing. `resolve` is a
//! pure function that takes the votes and the pool's total weight as
//! arguments — it does not read or write any contract state. Wiring this
//! into an actual `#[contract]` (an `Address`-keyed `Vote` store, a
//! `resolve(env, submission_id)` entry point, cross-contract calls into
//! `FlowRewards`) is later work that depends on this crate rather than
//! re-deriving these rules.
//!
//! # The quorum denominator
//!
//! Quorum is measured against **the total weight of the pool** (every
//! staked verifier, whether or not they voted on this particular
//! submission) — not against the weight of whoever happened to show up.
//!
//! This is the one design choice worth arguing for explicitly: a
//! participation-only denominator ("quorum = X% of the votes that were
//! cast") is trivially satisfied by a handful of colluding or simply fast
//! verifiers casting votes before anyone else notices the submission —
//! the quorum requirement stops doing any work. Measuring against the
//! whole pool means an attacker needs actual weight, not just speed, to
//! force a resolution.
//!
//! [`QUORUM_NUMERATOR`] / [`QUORUM_DENOMINATOR`] express the threshold as
//! a fraction of total pool weight (currently `1/2`, i.e. votes must
//! represent at least half the pool's total staked weight before a
//! submission resolves at all). Below that, [`resolve`] returns
//! [`Resolution::NoQuorum`] — the submission is neither approved nor
//! rejected, it simply isn't decided yet.
//!
//! # Ties
//!
//! When quorum is met and `approve_weight == reject_weight` exactly (this
//! includes the `0 == 0` case — see Abstentions below), [`resolve`] returns
//! [`Resolution::Rejected`].
//!
//! The rule is fail-closed on purpose: `SentinelPool` verifies data that
//! feeds a financial index (`KovaraIndex`). A submission should need an
//! actual, positive majority in its favor to be treated as verified;
//! anything that isn't a clear majority — a tie, or a quorum made up
//! entirely of abstentions — defaults to `Rejected` rather than `Approved`.
//! The failure mode of wrongly rejecting a good submission (resubmit) is
//! far cheaper than the failure mode of wrongly approving a bad one (bad
//! data enters the index).
//!
//! # Abstentions
//!
//! [`Verdict::Abstain`] counts its weight toward the quorum denominator's
//! numerator (an abstaining verifier still *showed up*, so their weight
//! counts as participation) but contributes to **neither**
//! `approve_weight` nor `reject_weight`. A pool where everyone abstains
//! reaches quorum (if their combined weight is enough) but resolves to
//! `Rejected` by the tie rule above, since `approve_weight` and
//! `reject_weight` are both `0`.

#![cfg_attr(not(test), allow(dead_code))]

use core::cmp::Ordering;

#[cfg(test)]
mod test;

/// A single verifier's vote on a submission.
///
/// `V` is left generic (rather than fixed to `soroban_sdk::Address`) since
/// this crate has no dependency on `soroban-sdk` — see the module docs for
/// why. The eventual contract wiring can call [`resolve`] with `Address`
/// directly, since the only requirement is [`PartialEq`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Vote<V> {
    /// Identifies the verifier who cast this vote. Only used to detect
    /// duplicate votes from the same verifier — [`resolve`] never inspects
    /// it otherwise.
    pub verifier: V,

    /// This verifier's voting weight (their staked amount at the time of
    /// voting). Must be greater than zero — see [`QuorumError::ZeroWeightVote`].
    pub weight: u128,

    /// What this verifier voted.
    pub verdict: Verdict,
}

/// A verifier's verdict on a submission.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Approve,
    Reject,
    /// Participates toward quorum but not toward the approve/reject tally.
    /// See the module-level "Abstentions" section.
    Abstain,
}

/// The outcome of resolving a submission's votes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolution {
    /// Quorum was met and `approve_weight` strictly exceeded `reject_weight`.
    Approved,
    /// Quorum was met, but `approve_weight` did not strictly exceed
    /// `reject_weight` — this covers both a genuine tie and the case where
    /// `Reject` weight led outright.
    Rejected,
    /// Combined `Approve` + `Reject` + `Abstain` weight did not reach
    /// [`QUORUM_NUMERATOR`] / [`QUORUM_DENOMINATOR`] of `total_pool_weight`.
    /// The submission is undecided, not rejected.
    NoQuorum,
}

/// Preconditions [`resolve`] enforces on its inputs. These are guardrails
/// against a misbehaving caller (e.g. a future contract layer with a bug
/// in how it assembles the vote list) — [`resolve`] itself never produces
/// a state that would trigger one of these from valid input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuorumError {
    /// The same verifier appears more than once in the vote list.
    DuplicateVoter,
    /// A vote was cast with `weight == 0`. A verifier with no stake has no
    /// voting weight and should not be able to cast a vote at all.
    ZeroWeightVote,
    /// `total_pool_weight` was `0`. Quorum is undefined against an empty
    /// pool — there is no "half of nothing" to reach.
    ZeroTotalPoolWeight,
    /// The votes' combined weight exceeds `total_pool_weight`. This can
    /// only happen if the caller passed a `total_pool_weight` that does
    /// not actually reflect every voter's registered stake.
    VoteExceedsPoolWeight,
    /// A weight sum overflowed `u128`. Not reachable with realistic stake
    /// amounts (Stellar balances are bounded well below `u128::MAX`), but
    /// checked rather than assumed.
    WeightOverflow,
}

/// Numerator of the quorum threshold, as a fraction of `total_pool_weight`.
pub const QUORUM_NUMERATOR: u128 = 1;
/// Denominator of the quorum threshold. `QUORUM_NUMERATOR` / `QUORUM_DENOMINATOR`
/// = `1/2`: at least half of the pool's total weight must participate
/// (`Approve` + `Reject` + `Abstain`) before a submission resolves.
pub const QUORUM_DENOMINATOR: u128 = 2;

/// Resolve a submission's votes into an [`Resolution`].
///
/// `votes` is every vote cast on the submission; `total_pool_weight` is the
/// combined staked weight of every verifier registered in the pool at
/// resolution time (not just those in `votes`) — see the module-level
/// "quorum denominator" section for why the two are different.
///
/// Returns `Err` if `votes` or `total_pool_weight` violate one of the
/// [`QuorumError`] preconditions; otherwise returns the [`Resolution`].
pub fn resolve<V: PartialEq>(
    votes: &[Vote<V>],
    total_pool_weight: u128,
) -> Result<Resolution, QuorumError> {
    if total_pool_weight == 0 {
        return Err(QuorumError::ZeroTotalPoolWeight);
    }

    let mut approve_weight: u128 = 0;
    let mut reject_weight: u128 = 0;
    let mut participating_weight: u128 = 0;

    for (i, vote) in votes.iter().enumerate() {
        if vote.weight == 0 {
            return Err(QuorumError::ZeroWeightVote);
        }

        // O(n^2) duplicate check is fine here: a verifier pool's vote list
        // per submission is small (bounded by however many verifiers the
        // pool has), and this only runs off-chain / in a resolve call, not
        // in a hot loop.
        for earlier in &votes[..i] {
            if earlier.verifier == vote.verifier {
                return Err(QuorumError::DuplicateVoter);
            }
        }

        participating_weight = participating_weight
            .checked_add(vote.weight)
            .ok_or(QuorumError::WeightOverflow)?;

        if participating_weight > total_pool_weight {
            return Err(QuorumError::VoteExceedsPoolWeight);
        }

        match vote.verdict {
            Verdict::Approve => {
                approve_weight = approve_weight
                    .checked_add(vote.weight)
                    .ok_or(QuorumError::WeightOverflow)?;
            }
            Verdict::Reject => {
                reject_weight = reject_weight
                    .checked_add(vote.weight)
                    .ok_or(QuorumError::WeightOverflow)?;
            }
            Verdict::Abstain => {
                // Counts toward `participating_weight` (already added
                // above) but not toward either tally.
            }
        }
    }

    // participating_weight / total_pool_weight >= QUORUM_NUMERATOR / QUORUM_DENOMINATOR
    // rearranged to avoid division: participating_weight * QUORUM_DENOMINATOR >= total_pool_weight * QUORUM_NUMERATOR
    let lhs = participating_weight
        .checked_mul(QUORUM_DENOMINATOR)
        .ok_or(QuorumError::WeightOverflow)?;
    let rhs = total_pool_weight
        .checked_mul(QUORUM_NUMERATOR)
        .ok_or(QuorumError::WeightOverflow)?;

    if lhs < rhs {
        return Ok(Resolution::NoQuorum);
    }

    match approve_weight.cmp(&reject_weight) {
        // Strictly more Approve weight than Reject weight: Approved.
        Ordering::Greater => Ok(Resolution::Approved),
        // Equal (a genuine tie, or 0 == 0 when everyone abstained) or Reject
        // weight leads outright: both resolve to Rejected. See the
        // module-level "Ties" section for the fail-closed rationale.
        Ordering::Equal | Ordering::Less => Ok(Resolution::Rejected),
    }
}
