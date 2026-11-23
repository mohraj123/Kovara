//! Exhaustive tests for [`resolve`], covering the quorum, tie, and
//! abstention rules the module docs on `lib.rs` describe. Each test name
//! states the scenario it pins down; taken together they are the
//! executable half of "documented and exhaustively tested" from CT-015's
//! acceptance criteria.

use super::*;

fn vote(verifier: u32, weight: u128, verdict: Verdict) -> Vote<u32> {
    Vote {
        verifier,
        weight,
        verdict,
    }
}

// ── Quorum denominator ──────────────────────────────────────────────────

#[test]
fn no_votes_is_no_quorum() {
    let votes: Vec<Vote<u32>> = vec![];
    assert_eq!(resolve(&votes, 100), Ok(Resolution::NoQuorum));
}

#[test]
fn participation_below_half_of_total_pool_weight_is_no_quorum() {
    // 49/100 participating: one short of the 1/2 threshold.
    let votes = vec![vote(1, 49, Verdict::Approve)];
    assert_eq!(resolve(&votes, 100), Ok(Resolution::NoQuorum));
}

#[test]
fn participation_at_exactly_half_of_total_pool_weight_reaches_quorum() {
    // 50/100 participating: the threshold is inclusive.
    let votes = vec![vote(1, 50, Verdict::Approve)];
    assert_eq!(resolve(&votes, 100), Ok(Resolution::Approved));
}

#[test]
fn quorum_is_measured_against_total_pool_weight_not_just_voters() {
    // Two verifiers of a 1000-weight pool both vote Approve with only 100
    // combined weight. If quorum were measured against participating
    // weight alone (100), this would trivially "reach quorum" against
    // itself. Measured against the real pool total (1000), it does not.
    let votes = vec![
        vote(1, 50, Verdict::Approve),
        vote(2, 50, Verdict::Approve),
    ];
    assert_eq!(resolve(&votes, 1000), Ok(Resolution::NoQuorum));
}

#[test]
fn full_pool_weight_participating_reaches_quorum() {
    let votes = vec![vote(1, 100, Verdict::Approve)];
    assert_eq!(resolve(&votes, 100), Ok(Resolution::Approved));
}

// ── Ties ─────────────────────────────────────────────────────────────────

#[test]
fn equal_nonzero_approve_and_reject_weight_resolves_to_rejected() {
    let votes = vec![
        vote(1, 50, Verdict::Approve),
        vote(2, 50, Verdict::Reject),
    ];
    assert_eq!(resolve(&votes, 100), Ok(Resolution::Rejected));
}

#[test]
fn approve_strictly_greater_than_reject_resolves_to_approved() {
    let votes = vec![
        vote(1, 60, Verdict::Approve),
        vote(2, 40, Verdict::Reject),
    ];
    assert_eq!(resolve(&votes, 100), Ok(Resolution::Approved));
}

#[test]
fn reject_strictly_greater_than_approve_resolves_to_rejected() {
    let votes = vec![
        vote(1, 40, Verdict::Approve),
        vote(2, 60, Verdict::Reject),
    ];
    assert_eq!(resolve(&votes, 100), Ok(Resolution::Rejected));
}

// ── Abstentions ──────────────────────────────────────────────────────────

#[test]
fn all_abstain_reaching_quorum_resolves_to_rejected() {
    // Everyone shows up (reaching quorum) but nobody actually votes for or
    // against: approve_weight == reject_weight == 0, so the tie rule
    // applies.
    let votes = vec![
        vote(1, 60, Verdict::Abstain),
        vote(2, 40, Verdict::Abstain),
    ];
    assert_eq!(resolve(&votes, 100), Ok(Resolution::Rejected));
}

#[test]
fn abstain_counts_toward_quorum_but_not_the_tally() {
    // 30 Approve + 10 Reject + 60 Abstain = 100/100 participating, which
    // reaches quorum purely because Abstain weight is included. The tally
    // is decided only by the 30 vs 10 split.
    let votes = vec![
        vote(1, 30, Verdict::Approve),
        vote(2, 10, Verdict::Reject),
        vote(3, 60, Verdict::Abstain),
    ];
    assert_eq!(resolve(&votes, 100), Ok(Resolution::Approved));
}

#[test]
fn abstain_alone_can_be_insufficient_for_quorum() {
    let votes = vec![vote(1, 40, Verdict::Abstain)];
    assert_eq!(resolve(&votes, 100), Ok(Resolution::NoQuorum));
}

// ── Precondition errors ─────────────────────────────────────────────────

#[test]
fn zero_total_pool_weight_is_an_error() {
    let votes = vec![vote(1, 10, Verdict::Approve)];
    assert_eq!(resolve(&votes, 0), Err(QuorumError::ZeroTotalPoolWeight));
}

#[test]
fn zero_weight_vote_is_an_error() {
    let votes = vec![vote(1, 0, Verdict::Approve)];
    assert_eq!(resolve(&votes, 100), Err(QuorumError::ZeroWeightVote));
}

#[test]
fn duplicate_voter_is_an_error() {
    let votes = vec![
        vote(1, 10, Verdict::Approve),
        vote(2, 10, Verdict::Reject),
        vote(1, 10, Verdict::Approve),
    ];
    assert_eq!(resolve(&votes, 100), Err(QuorumError::DuplicateVoter));
}

#[test]
fn votes_exceeding_total_pool_weight_is_an_error() {
    // Combined vote weight (60 + 60 = 120) exceeds the stated pool total
    // (100) — the caller must have passed a `total_pool_weight` that
    // doesn't reflect every voter's registered stake.
    let votes = vec![
        vote(1, 60, Verdict::Approve),
        vote(2, 60, Verdict::Reject),
    ];
    assert_eq!(
        resolve(&votes, 100),
        Err(QuorumError::VoteExceedsPoolWeight)
    );
}

#[test]
fn weight_overflow_in_quorum_check_is_an_error() {
    // A single voter holding the entire (near-u128::MAX) pool weight
    // doesn't exceed total_pool_weight, but doubling it for the quorum
    // comparison (`participating_weight * QUORUM_DENOMINATOR`) overflows
    // u128 and must be caught rather than silently wrapping.
    let total = u128::MAX;
    let votes = vec![vote(1, total, Verdict::Approve)];
    assert_eq!(resolve(&votes, total), Err(QuorumError::WeightOverflow));
}
