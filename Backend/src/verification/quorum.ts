/**
 * Community verification quorum (issue #644).
 *
 * Decides whether a price submission has been verified by the community. This
 * module is deliberately pure: no clock, no randomness, no I/O. Given the same
 * vote set it returns the same result, which is what lets the moderation and
 * rewards layers (#645, #656) reason about a submission without re-reading the
 * vote history and hoping it has not shifted underneath them.
 *
 * The single rule that matters most: **a vote count alone never verifies
 * anything.** A submission with one approval out of one vote has a perfect
 * 1.0 approval ratio, and must still fail. A quorum has two independent
 * conditions — enough active voters, and enough of them approving — and this
 * module reports which one failed.
 */

/** A single community vote. Mirrors `VerificationVote` in the API route. */
export interface QuorumVote {
  voter: string;
  choice: "approve" | "reject";
  /** ISO 8601 timestamp. Used only to break ties between duplicate entries. */
  votedAt?: string;
  /**
   * Soft-deleted or superseded votes. Inactive votes are excluded from every
   * count, so a retracted vote cannot keep a submission alive.
   */
  active?: boolean;
}

/**
 * Canonicalize formatting variants of a Stellar account address.
 *
 * Non-address voter identifiers are left untouched for compatibility with
 * callers that use opaque test or migration identifiers.
 */
export function normalizeVoterIdentity(voter: string): string {
  const trimmed = voter.trim();
  return /^G[A-Z2-7]{55}$/i.test(trimmed) ? trimmed.toUpperCase() : voter;
}

/** Thresholds a submission must clear. */
export interface QuorumConfig {
  /** Minimum number of distinct active voters before any ratio is consulted. */
  minVoters?: number;
  /**
   * Required share of approvals, as an exact fraction. A rational rather than
   * a float so the comparison can be done in integer arithmetic — see
   * `meetsRatio`.
   */
  approvalRatio?: Ratio;
  /**
   * Maximum share of rejections tolerated, as an exact fraction. A submission
   * with enough voters but too much dissent is failed rather than left
   * undecided, so a submission that is actively being rejected does not sit in
   * a pending state forever.
   */
  rejectionCeiling?: Ratio;
}

/** An exact fraction. `2/3` is represented as `{ 2, 3 }`. */
export interface Ratio {
  numerator: number;
  denominator: number;
}

/** Why a submission did or did not verify. */
export type QuorumReason =
  | "approved"
  | "insufficient_voters"
  | "approval_below_threshold"
  | "rejection_above_ceiling"
  | "no_active_votes";

/**
 * A typed, actionable summary of where a submission stands. It is derived from
 * the same counts and reasons as before; it does not change any threshold.
 *
 *  - `insufficient`: too few distinct active voters for any verdict yet;
 *    `votesNeeded` more are required.
 *  - `conflicting`: enough voters, but approvals and rejections both exist and
 *    the split misses the approval threshold or exceeds the rejection ceiling.
 *    `approvalsShort` is how many more approvals the current voters would need.
 *  - `rejected`: enough voters and no approvals at all (unanimous rejection).
 *  - `satisfied`: quorum and ratio conditions are both met.
 */
export type QuorumOutcome =
  | { status: "insufficient"; votesNeeded: number }
  | { status: "conflicting"; approvals: number; rejections: number; approvalsShort: number }
  | { status: "rejected"; rejections: number }
  | { status: "satisfied" };

export interface QuorumResult {
  /** True only when every quorum condition is satisfied. */
  passed: boolean;
  /**
   * False when the vote set cannot yet produce a verdict. Distinct from
   * `passed === false`: a submission awaiting more voters is `pending`, while
   * one rejected by dissent is `failed`, and callers treat those differently.
   */
  decided: boolean;
  reason: QuorumReason;
  /** Distinct active voters, after de-duplication. */
  totalActive: number;
  approvals: number;
  rejections: number;
  /** Votes still needed before the ratio is even consulted. */
  minVoters: number;
  /** Approvals needed to satisfy `approvalRatio`, given the current voters. */
  requiredApprovals: number;
  approvalRatio: Ratio;
  rejectionCeiling: Ratio;
  /** Typed status for callers that need to branch on why it is not verified. */
  outcome: QuorumOutcome;
}

/** Default: three distinct voters, two-thirds approval, one-third rejection. */
export const DEFAULT_QUORUM_CONFIG: Required<QuorumConfig> = {
  minVoters: 3,
  approvalRatio: { numerator: 2, denominator: 3 },
  rejectionCeiling: { numerator: 1, denominator: 3 },
};

/**
 * Compare `part`/`whole` against `target` exactly, in integer arithmetic.
 *
 * `2/3 >= 2/3` and floating point agrees. `1/3 >= 2/3` also agrees. The cases
 * where floats disagree are the ones that matter here: a submission with 2
 * approvals out of 3 voters should sit exactly on the 2/3 threshold, and
 * `2/3 >= 2/3` computed as doubles can round either way depending on the order
 * the division happened in. Cross-multiplying (`2 * 3 >= 2 * 3`) has no such
 * ambiguity, so the same vote set always lands on the same side of the line.
 */
export function meetsRatio(part: number, whole: number, target: Ratio): boolean {
  if (whole <= 0) return false;
  if (target.denominator <= 0) {
    throw new Error("meetsRatio: target.denominator must be positive");
  }
  return part * target.denominator >= whole * target.numerator;
}

/**
 * The mirror of `meetsRatio`: true when `part`/`whole` stays at or below
 * `ceiling`.
 *
 * The rejection ceiling needs this direction. Using `meetsRatio` for it would
 * ask whether dissent is *at least* one third and fail submissions that are
 * merely un-dissenting — the opposite of the intent.
 */
export function withinRatio(part: number, whole: number, ceiling: Ratio): boolean {
  if (whole <= 0) return true;
  if (ceiling.denominator <= 0) {
    throw new Error("withinRatio: ceiling.denominator must be positive");
  }
  return part * ceiling.denominator <= whole * ceiling.numerator;
}

/** Ceiling division, rounding up: the smallest `n` with `n/total >= target`. */
function requiredCountFor(total: number, target: Ratio): number {
  if (total <= 0) return 0;
  if (target.denominator <= 0) {
    throw new Error("requiredCountFor: target.denominator must be positive");
  }
  return Math.ceil((total * target.numerator) / target.denominator);
}

function validateRatio(ratio: Ratio, name: string): void {
  if (!Number.isInteger(ratio.numerator) || ratio.numerator < 0) {
    throw new Error(`${name}: numerator must be a non-negative integer`);
  }
  if (!Number.isInteger(ratio.denominator) || ratio.denominator <= 0) {
    throw new Error(`${name}: denominator must be a positive integer`);
  }
}

/**
 * Reduce a vote list to one entry per active voter.
 *
 * De-duplication exists because a vote list assembled from more than one
 * source can contain the same voter twice, and counting them twice would let a
 * single account manufacture a quorum. When a voter appears more than once the
 * most recent `votedAt` wins, matching the overwrite semantics the API already
 * uses; a tie is broken on the vote text so the outcome does not depend on
 * array order.
 */
export function resolveActiveVotes(votes: readonly QuorumVote[]): QuorumVote[] {
  const latest = new Map<string, QuorumVote>();

  for (const vote of votes) {
    if (vote.active === false) continue;

    const voter = normalizeVoterIdentity(vote.voter);
    const normalizedVote = voter === vote.voter ? vote : { ...vote, voter };
    const existing = latest.get(voter);
    if (existing === undefined) {
      latest.set(voter, normalizedVote);
      continue;
    }

    const existingAt = existing.votedAt ?? "";
    const candidateAt = vote.votedAt ?? "";
    if (candidateAt > existingAt) {
      latest.set(voter, normalizedVote);
    } else if (candidateAt === existingAt && vote.choice > existing.choice) {
      // Deterministic tie-break. Without this, two entries with identical
      // timestamps resolve to whichever the caller's array happened to list
      // first, so the same votes could produce two different results.
      latest.set(voter, normalizedVote);
    }
  }

  // Sort by voter so the returned order — and therefore anything derived from
  // it downstream — is stable across runs.
  return [...latest.values()].sort((a, b) => (a.voter < b.voter ? -1 : a.voter > b.voter ? 1 : 0));
}

/**
 * Evaluate a submission's quorum.
 *
 * Pure and total: it never throws for a well-formed vote list, and returns a
 * `reason` that names the condition which failed rather than a bare boolean.
 */
export function evaluateQuorum(
  votes: readonly QuorumVote[],
  config: QuorumConfig = {}
): QuorumResult {
  const minVoters = config.minVoters ?? DEFAULT_QUORUM_CONFIG.minVoters;
  const approvalRatio = config.approvalRatio ?? DEFAULT_QUORUM_CONFIG.approvalRatio;
  const rejectionCeiling = config.rejectionCeiling ?? DEFAULT_QUORUM_CONFIG.rejectionCeiling;

  if (!Number.isInteger(minVoters) || minVoters < 1) {
    throw new Error("evaluateQuorum: minVoters must be a positive integer");
  }
  validateRatio(approvalRatio, "approvalRatio");
  validateRatio(rejectionCeiling, "rejectionCeiling");

  const active = resolveActiveVotes(votes);
  const totalActive = active.length;
  const approvals = active.filter((v) => v.choice === "approve").length;
  const rejections = totalActive - approvals;
  const requiredApprovals = requiredCountFor(totalActive, approvalRatio);

  const base = {
    totalActive,
    approvals,
    rejections,
    minVoters,
    requiredApprovals,
    approvalRatio,
    rejectionCeiling,
  };

  const insufficient: QuorumOutcome = {
    status: "insufficient",
    votesNeeded: Math.max(0, minVoters - totalActive),
  };
  const failedOutcome = (): QuorumOutcome =>
    approvals === 0
      ? { status: "rejected", rejections }
      : {
          status: "conflicting",
          approvals,
          rejections,
          approvalsShort: Math.max(0, requiredApprovals - approvals),
        };

  if (totalActive === 0) {
    return { ...base, passed: false, decided: false, reason: "no_active_votes", outcome: insufficient };
  }

  // Order matters. Quorum is checked before any ratio so that a small vote set
  // with a flattering ratio is reported as undecided rather than as failed —
  // the submission is waiting for voters, not being rejected.
  if (totalActive < minVoters) {
    return { ...base, passed: false, decided: false, reason: "insufficient_voters", outcome: insufficient };
  }

  if (!meetsRatio(approvals, totalActive, approvalRatio)) {
    return { ...base, passed: false, decided: true, reason: "approval_below_threshold", outcome: failedOutcome() };
  }

  if (!withinRatio(rejections, totalActive, rejectionCeiling)) {
    return { ...base, passed: false, decided: true, reason: "rejection_above_ceiling", outcome: failedOutcome() };
  }

  return { ...base, passed: true, decided: true, reason: "approved", outcome: { status: "satisfied" } };
}

/** True when a submission has enough voters for a verdict to exist at all. */
export function hasQuorum(
  votes: readonly QuorumVote[],
  config: QuorumConfig = {}
): boolean {
  return evaluateQuorum(votes, config).decided;
}
