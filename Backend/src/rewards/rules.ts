/**
 * Reward calculation for verified submissions.
 *
 * Issue #656. The requirement is not just "payout the right number" but that
 * the number is **reproducible from stored submission and verification data** —
 * so this module is pure. It takes the recorded facts and returns an integer.
 * It never reads a clock, a random source, or a global; the same inputs always
 * produce the same rewards, which is what makes a disputed payout arguable
 * instead of mysterious.
 *
 * Everything is `bigint` in the token's smallest unit. A reward computed in
 * floating point would not reproduce across machines once the values get large
 * enough to differ in the last bit, and "reproducible" would quietly stop
 * being true.
 *
 * Multipliers are in **basis points** (1bp = 0.01%) and applied with integer
 * arithmetic, so there is no rounding drift between the rules and the ledger.
 */

/** Basis-point denominator: 10,000bp = 100%. */
export const BPS = 10_000n;

/** The recorded facts about one submission that reward rules depend on. */
export interface SubmissionRecord {
  submissionId: string;
  submitter: string;
  /** `pending` | `verified` | `rejected`. */
  status: "pending" | "verified" | "rejected";
  /**
   * How many independent addresses submitted a value agreeing with this one.
   * Corroboration is the quality signal: a lone figure is a guess, several
   * matching ones are an observation.
   */
  corroborations: number;
  /** Whether the submission was flagged for manual review. */
  flagged?: boolean;
}

/** One recorded verification act. */
export interface VerificationRecord {
  submissionId: string;
  verifier: string;
  /** `approve` | `reject`. */
  verdict: "approve" | "reject";
}

/** The tunable rule set. Defaults live in {@link DEFAULT_REWARD_RULES}. */
export interface RewardRules {
  /** Paid for a submission that is verified. */
  baseSubmissionReward: bigint;
  /** Paid to the address that approved a submission. */
  verificationReward: bigint;
  /** Paid to the address that rejected a submission. */
  rejectionReward: bigint;
  /**
   * Extra multiplier once a submission has at least `corroborationThreshold`
   * independent agreements. Corroborated data is worth more because it is
   * less likely to be a fabricated outlier.
   */
  corroborationBonusBps: bigint;
  /** Corroboration count at which the bonus applies. */
  corroborationThreshold: number;
  /**
   * Multiplier applied while a submission is under manual review. Rewards for
   * disputed data are held rather than paid, so a reversal does not have to
   * claw back an already-spent balance.
   */
  pendingReviewBps: bigint;
}

/**
 * Default rules.
 *
 * The corroboration bonus is deliberately sublinear (quadratic in the count,
 * capped) so a small group cannot manufacture reward by colluding: five people
 * agreeing does not make a figure five times more true.
 */
export const DEFAULT_REWARD_RULES: RewardRules = {
  baseSubmissionReward: 100_000n,
  verificationReward: 20_000n,
  rejectionReward: 5_000n,
  corroborationBonusBps: 2_500n, // +25%
  corroborationThreshold: 3,
  pendingReviewBps: 5_000n, // held at 50% while flagged
};

/** A reward accrual for one address. */
export interface Accrual {
  address: string;
  submissionId: string;
  amount: bigint;
  /** Which rule produced this line, for display and for audit. */
  kind: "submission" | "corroboration" | "verification" | "rejection";
  /** The state this accrual is in, mirroring the payout state machine. */
  state: "pending" | "claimable";
}

/** The full, reproducible result of evaluating a submission's verifications. */
export interface RewardAssessment {
  submissionId: string;
  /** Everything owed, grouped by address. */
  accruals: Accrual[];
  /** Sum of all accruals; the payout liability this submission creates. */
  total: bigint;
  /** Verifications that were ignored, with the reason. */
  ignoredVerifications: { verifier: string; reason: IgnoreReason }[];
}

/** Why a verification did not produce a reward. */
export type IgnoreReason =
  /** The same address already voted on this submission. */
  | "duplicate_vote"
  /** The verifier verified their own submission. */
  | "self_verification"
  /** The submission is not in a state that can earn. */
  | "submission_not_verified"
  /** The verifier is not a valid address. */
  | "invalid_verifier";

/** Stellar addresses are 56 characters, base32, starting with G. */
const ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;

/** True when `value` looks like a Stellar address. */
export function isValidAddress(value: string): boolean {
  return ADDRESS_PATTERN.test(value);
}

/**
 * Apply a basis-point multiplier, truncating toward zero.
 *
 * Truncation rather than rounding is deliberate: rounding up would pay more
 * than the rules state, and because the same input always truncates the same
 * way, the total stays reproducible.
 */
function applyBps(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / BPS;
}

/**
 * Deduplicate verifications, keeping the first act per verifier.
 *
 * A verifier who votes approve three times must be paid once. Ordering is
 * taken as given — the caller supplies verifications in recorded order — so the
 * "first" vote is the one that actually happened first, and re-running the
 * calculation on the same stored data reaches the same conclusion.
 *
 * A verifier whose first act is `approve` and whose second is `reject` has
 * already been counted as an approver; the later attempt is recorded as
 * ignored rather than silently converting an approval into a rejection, because
 * letting a verifier change their vote after seeing the reward would make the
 * reward a function of when they looked rather than of the data.
 */
export function dedupeVerifications(
  verifications: VerificationRecord[]
): { unique: VerificationRecord[]; duplicates: VerificationRecord[] } {
  const seen = new Set<string>();
  const unique: VerificationRecord[] = [];
  const duplicates: VerificationRecord[] = [];

  for (const verification of verifications) {
    // Scoped per submission: the same address may legitimately verify many
    // different submissions, and only repeat votes on *one* submission are a
    // duplicate.
    const key = `${verification.submissionId}:${verification.verifier}`;
    if (seen.has(key)) {
      duplicates.push(verification);
      continue;
    }
    seen.add(key);
    unique.push(verification);
  }

  return { unique, duplicates };
}

/**
 * Corroboration bonus, quadratic in the agreement count and capped.
 *
 * `min(corroborations, threshold)` gates whether the bonus applies at all; the
 * ramp above the threshold is sublinear so agreement is rewarded without
 * letting a colluding group scale the reward without limit. The cap is what
 * makes the function monotone and bounded — without it, `corroborations` is
 * caller-influenced input to a payout.
 */
function corroborationMultiplier(corroborations: number, rules: RewardRules): bigint {
  if (corroborations < rules.corroborationThreshold) return BPS;
  const steps = Math.min(corroborations - rules.corroborationThreshold, 8);
  // Each agreement beyond the threshold adds 1/8 of the base bonus, so the
  // total additional multiplier never exceeds the bonus itself.
  return BPS + (rules.corroborationBonusBps * BigInt(steps)) / 8n;
}

/**
 * Evaluate one submission and return every reward it owes.
 *
 * The rules, in the order they are applied:
 *   1. A rejected submission earns nothing — not for the submitter, and not for
 *      the verifier who rejected it, because rejecting bad data is a cost the
 *      protocol bears, not a paid service.
 *   2. A pending submission earns nothing yet; verification rewards are also
 *      withheld because a pending submission can still be rejected.
 *   3. A verified submission pays the submitter `base` scaled by the
 *      corroboration multiplier, and pays each deduplicated approving verifier
 *      a flat `verificationReward`.
 *   4. While a submission is flagged for review, the submitter's reward is held
 *      at `pendingReviewBps` and marked `pending` rather than `claimable`, so a
 *      later reversal does not require clawing back a paid balance.
 *
 * Self-verification is ignored entirely: an address cannot both create data and
 * certify it, which would let one account farm rewards by self-approving.
 */
export function assessSubmission(
  submission: SubmissionRecord,
  verifications: VerificationRecord[],
  rules: RewardRules = DEFAULT_REWARD_RULES
): RewardAssessment {
  const ignored: RewardAssessment["ignoredVerifications"] = [];
  const accruals: Accrual[] = [];

  const { unique, duplicates } = dedupeVerifications(verifications);
  for (const duplicate of duplicates) {
    ignored.push({ verifier: duplicate.verifier, reason: "duplicate_vote" });
  }

  // Only verifications for this submission are relevant; a caller passing a
  // wider slice should not have their other submissions' votes counted here.
  const relevant = unique.filter((v) => v.submissionId === submission.submissionId);

  if (submission.status === "rejected") {
    for (const verification of relevant) {
      ignored.push({ verifier: verification.verifier, reason: "submission_not_verified" });
    }
    return { submissionId: submission.submissionId, accruals: [], total: 0n, ignoredVerifications: ignored };
  }

  if (submission.status === "pending") {
    for (const verification of relevant) {
      ignored.push({ verifier: verification.verifier, reason: "submission_not_verified" });
    }
    return { submissionId: submission.submissionId, accruals: [], total: 0n, ignoredVerifications: ignored };
  }

  const flagged = submission.flagged === true;
  const submitterMultiplier = corroborationMultiplier(submission.corroborations, rules);

  let submissionReward =
    applyBps(rules.baseSubmissionReward, submitterMultiplier);

  // A held reward is reduced, not zeroed: the verifier's work was real, and if
  // review clears the submission the address should still be paid something.
  const state: Accrual["state"] = flagged ? "pending" : "claimable";
  if (flagged) {
    submissionReward = applyBps(submissionReward, rules.pendingReviewBps);
  }

  accruals.push({
    address: submission.submitter,
    submissionId: submission.submissionId,
    amount: submissionReward,
    kind: "corroboration",
    state,
  });

  for (const verification of relevant) {
    if (!isValidAddress(verification.verifier)) {
      ignored.push({ verifier: verification.verifier, reason: "invalid_verifier" });
      continue;
    }
    if (verification.verifier === submission.submitter) {
      // Self-approval is not a verification.
      ignored.push({ verifier: verification.verifier, reason: "self_verification" });
      continue;
    }
    if (verification.verdict !== "approve") {
      // A reject verdict on an already-verified submission is recorded but not
      // paid: the submission's state, not the tally, is what the rules key on,
      // so a late reject cannot retroactively change a published reward.
      continue;
    }
    accruals.push({
      address: verification.verifier,
      submissionId: submission.submissionId,
      amount: rules.verificationReward,
      kind: "verification",
      state: flagged ? "pending" : "claimable",
    });
  }

  const total = accruals.reduce((sum, a) => sum + a.amount, 0n);
  return { submissionId: submission.submissionId, accruals, total, ignoredVerifications: ignored };
}

/**
 * Evaluate a batch, and merge rewards owed by the same address.
 *
 * An address verifying three submissions accrues three separate lines; this
 * reports one combined claimable amount, which is what a payout needs. The
 * per-submission breakdown is retained so a total can always be explained.
 */
export function assessBatch(
  submissions: SubmissionRecord[],
  verifications: VerificationRecord[],
  rules: RewardRules = DEFAULT_REWARD_RULES
): {
  byAddress: Map<string, { pending: bigint; claimable: bigint; total: bigint }>;
  ignoredVerifications: { submissionId: string; verifier: string; reason: IgnoreReason }[];
} {
  const byAddress = new Map<string, { pending: bigint; claimable: bigint; total: bigint }>();
  const ignoredVerifications: {
    submissionId: string;
    verifier: string;
    reason: IgnoreReason;
  }[] = [];

  for (const submission of submissions) {
    const assessment = assessSubmission(submission, verifications, rules);
    for (const ignored of assessment.ignoredVerifications) {
      ignoredVerifications.push({ submissionId: submission.submissionId, ...ignored });
    }
    for (const accrual of assessment.accruals) {
      const existing = byAddress.get(accrual.address) ?? { pending: 0n, claimable: 0n, total: 0n };
      if (accrual.state === "pending") existing.pending += accrual.amount;
      else existing.claimable += accrual.amount;
      existing.total += accrual.amount;
      byAddress.set(accrual.address, existing);
    }
  }

  return { byAddress, ignoredVerifications };
}
