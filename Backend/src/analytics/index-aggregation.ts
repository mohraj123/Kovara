/**
 * Index computation: robust aggregation and outlier rejection.
 *
 * Issues #652 and #653. The price index is built from crowdsourced
 * observations, which means the input is adversarial by default: anyone can
 * submit a number, and a single absurd submission (a rent figure 1000x the
 * real one, a price in the wrong unit) moves a plain mean far more than it
 * moves reality. Two properties are needed:
 *
 *   - **Consistent central value** (#652). A median, not a mean: the median is
 *     the value that splits the sample in half, so up to half the observations
 *     can be arbitrarily wrong before it moves at all. A mean, by contrast,
 *     moves linearly with any single contribution.
 *   - **Explicit exclusion rules** (#653). Outliers and invalid records are
 *     removed *before* aggregation and excluded from the canonical index, and
 *     every decision is recorded so it can be reviewed and debugged.
 *
 * Why a median and not a trimmed mean: both resist outliers, but the median
 * needs no tuning parameter, is exactly reproducible with integer arithmetic
 * (see below), and has a bounded breakdown point of 50% — the highest possible.
 * A trimmed mean requires choosing how much to trim, and that choice is
 * arbitrary; a 10% trim tolerates 10% corruption, a 40% trim tolerates 40% but
 * discards 40% of good data.
 *
 * Everything here is integer arithmetic. Prices are the contract's `i128` in the
 * smallest fixed-point unit, so they are `bigint` here. Floating point is
 * avoided throughout, for two reasons: `Number` cannot represent integers
 * beyond 2^53-1, which a scaled token price can exceed, and a median that
 * rounds differently on two runs is not reproducible.
 *
 * The functions are pure and total: the same input set always produces the same
 * output, which is what lets #654 serve a stored aggregate and recompute an
 * identical one.
 */

/** One observation as the aggregation consumes it. */
export interface PricePoint {
  /** Stable id of the submission, used in the filter decisions log. */
  submissionId: string;
  /** Price in the contract's smallest fixed-point unit. */
  value: bigint;
  /** Submitting address, used to cap per-submitter influence. */
  submitter: string;
  /** `pending` | `verified` | `rejected`. */
  status: "pending" | "verified" | "rejected";
  /** Observation time in seconds since the epoch. */
  timestamp: number;
}

/** Why a submission was kept or dropped. */
export type FilterReason =
  | "included"
  | "invalid_value"
  | "rejected_status"
  | "pending_status"
  | "below_minimum"
  | "above_maximum"
  | "outlier_mad"
  | "outlier_iquartile"
  | "submitter_cap"
  | "insufficient_sample";

/** Every reason, in the order the pipeline applies them. */
export const FILTER_REASONS: readonly FilterReason[] = [
  "included",
  "invalid_value",
  "rejected_status",
  "pending_status",
  "below_minimum",
  "above_maximum",
  "outlier_mad",
  "outlier_iquartile",
  "submitter_cap",
  "insufficient_sample",
] as const;

/** One recorded filter decision, retained so exclusions can be audited. */
export interface FilterDecision {
  submissionId: string;
  value: bigint;
  included: boolean;
  reason: FilterReason;
  /**
   * The threshold that excluded this value, when the reason is a bound or an
   * outlier. Null otherwise, so a decision log entry always explains itself.
   */
  threshold: bigint | null;
}

/** Tunables for {@link filterOutliers}. */
export interface FilterOptions {
  /** Lowest acceptable price. Default 0n (the contract requires > 0). */
  minValue?: bigint;
  /**
   * Highest acceptable price. Default null (unbounded). Set this to reject a
   * unit mistake — someone submitting rent in kobo rather than naira — which no
   * statistical method can distinguish from a legitimate extreme.
   */
  maxValue?: bigint;
  /**
   * Reject values beyond this many median-absolute-deviations from the median.
   * Default 3.0. Set to null to disable MAD filtering.
   */
  madThreshold?: number | null;
  /**
   * Reject values outside [Q1 - k*IQR, Q3 + k*IQR]. Default 1.5, the standard
   * Tukey fence. Set to null to disable.
   */
  iqrMultiplier?: number | null;
  /** Only aggregate these statuses. Default `verified`. */
  includeStatuses?: PricePoint["status"][];
  /**
   * Cap the share of the sample a single submitter may account for. Default
   * null. When set, a submitter whose observations exceed the share has their
   * excess dropped lowest-value-first.
   */
  maxSubmitterShare?: number;
}

/** The outcome of filtering and aggregating a set of observations. */
export interface AggregationResult {
  /** Median of the included values, or null when nothing survived. */
  median: bigint | null;
  /**
   * Credibility-weighted mean of the included values, or null when nothing
   * survived. See {@link weightedMean} for how the weights are derived.
   */
  weighted: bigint | null;
  /** Number of observations considered. */
  inputCount: number;
  /** Number that survived filtering and contributed. */
  includedCount: number;
  /** Number excluded, with a per-reason breakdown. */
  excludedCount: number;
  /** Every decision, in input order. Retained for review. */
  decisions: FilterDecision[];
  /** Exclusions grouped by reason, for a summary view. */
  excludedByReason: Record<FilterReason, number>;
}

/** A result with nothing to publish. */
function emptyResult(inputCount: number, decisions: FilterDecision[]): AggregationResult {
  return {
    median: null,
    weighted: null,
    inputCount,
    includedCount: 0,
    excludedCount: decisions.filter((d) => !d.included).length,
    decisions,
    excludedByReason: countByReason(decisions),
  };
}

function countByReason(decisions: FilterDecision[]): Record<FilterReason, number> {
  const counts = Object.fromEntries(
    FILTER_REASONS.map((reason) => [reason, 0])
  ) as Record<FilterReason, number>;
  for (const decision of decisions) {
    if (decision.included) counts.included += 1;
    else counts[decision.reason] += 1;
  }
  return counts;
}

/**
 * Median of a non-empty array, truncated toward zero.
 *
 * With an even count, the mathematical median is the mean of the two central
 * values and may be a half-integer. Truncating is the right choice for a
 * fixed-point price: the index must land on a representable amount, and
 * rounding up would systematically overstate the cost of living.
 *
 * The input is sorted in place, so pass a copy if the caller needs the original
 * order preserved.
 */
export function median(values: bigint[]): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2n;
}

/**
 * First quartile of a non-empty array, using the median-of-halves method.
 * Consistent with {@link median}, so the quartiles and the median describe the
 * same distribution.
 */
export function quartile(values: bigint[], which: 1 | 3): bigint | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;

  // Odd count: the median is a real observation, so the halves exclude it.
  // Even count: split at the midpoint, giving an equal lower and upper half.
  const lower = sorted.slice(0, sorted.length % 2 === 1 ? mid : mid);
  const upper = sorted.slice(sorted.length % 2 === 1 ? mid + 1 : mid);
  return median(which === 1 ? lower : upper);
}

/**
 * Median absolute deviation: `median(|x - median(x)|)`.
 *
 * Preferred over standard deviation for this data because it is computed from
 * the same robust centre and does not let the outliers inflate the very
 * measure meant to detect them — which is exactly the failure mode of a
 * standard-deviation filter on a contaminated sample.
 */
export function medianAbsoluteDeviation(values: bigint[]): bigint | null {
  const centre = median(values);
  if (centre === null) return null;
  return median(values.map((v) => (v >= centre ? v - centre : centre - v)));
}

/**
 * Credibility-weighted mean, after Box-Cox's power transform.
 *
 * The naive "weight by submission count" scheme is degenerate: a submitter
 * with ten submissions has ten times the influence of one with a single
 * submission, so a single determined actor dominates a thin country. Box-Cox's
 * idea is to compress the counts before weighting — `1 / n^lambda` — so ten
 * submissions count more than one, but not ten times more.
 *
 * `lambda` is 0.5 by default: a submitter with 4x the observations carries
 * 2x the weight. That rewards corroboration, which is the entire point of
 * crowdsourced pricing, without letting volume alone decide the index.
 *
 * Weights are applied as `weight * value` summed and divided by the total
 * weight, in integers. The division truncates, matching the convention used
 * for the median.
 */
export function weightedMean(
  values: bigint[],
  weights: number[],
  lambda = 0.5
): bigint | null {
  if (values.length === 0 || values.length !== weights.length) return null;
  if (weights.length === 0) return null;

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) return null;

  // Fixed-point weighting: integer weights keep the sum exact, so a large
  // sample cannot lose precision to a fractional weight.
  const SCALE = 1_000_000;
  let weightedSum = 0n;
  let weightTotal = 0;
  for (let i = 0; i < values.length; i++) {
    const weight = Math.max(0, Math.round(weights[i] * SCALE));
    weightTotal += weight;
    weightedSum += values[i] * BigInt(weight);
  }
  if (weightTotal === 0) return null;

  return weightedSum / BigInt(weightTotal);
}

/**
 * Per-submitter credibility weights `1 / n^lambda`.
 *
 * Exposed so a caller can inspect or override the weighting without
 * re-deriving it.
 */
export function credibilityWeights(
  points: PricePoint[],
  lambda = 0.5
): number[] {
  const counts = new Map<string, number>();
  for (const point of points) {
    counts.set(point.submitter, (counts.get(point.submitter) ?? 0) + 1);
  }
  return points.map((point) => {
    const n = counts.get(point.submitter) ?? 1;
    return 1 / Math.pow(Math.max(1, n), lambda);
  });
}

/**
 * Step 1 of aggregation: drop records that cannot contribute.
 *
 * Status and absolute bounds are checked before any statistics are computed,
 * because a status-rejected submission must not influence the very thresholds
 * used to judge other submissions.
 */
function applyBasicFilters(
  points: PricePoint[],
  options: Required<Pick<FilterOptions, "includeStatuses">> &
    Pick<FilterOptions, "minValue" | "maxValue">
): { kept: PricePoint[]; decisions: FilterDecision[] } {
  const { includeStatuses, minValue = 0n, maxValue = null } = options;
  const kept: PricePoint[] = [];
  const decisions: FilterDecision[] = [];

  for (const point of points) {
    if (point.status === "rejected") {
      decisions.push({ submissionId: point.submissionId, value: point.value, included: false, reason: "rejected_status", threshold: null });
      continue;
    }
    if (point.status === "pending" && !includeStatuses.includes("pending")) {
      decisions.push({ submissionId: point.submissionId, value: point.value, included: false, reason: "pending_status", threshold: null });
      continue;
    }
    // The contract requires value > 0; a zero or negative is corrupt data
    // rather than a measurement, and would drag a mean below the truth.
    if (point.value <= 0n) {
      decisions.push({ submissionId: point.submissionId, value: point.value, included: false, reason: "invalid_value", threshold: null });
      continue;
    }
    if (point.value < minValue) {
      decisions.push({ submissionId: point.submissionId, value: point.value, included: false, reason: "below_minimum", threshold: minValue });
      continue;
    }
    if (maxValue !== null && point.value > maxValue) {
      decisions.push({ submissionId: point.submissionId, value: point.value, included: false, reason: "above_maximum", threshold: maxValue });
      continue;
    }
    kept.push(point);
  }

  return { kept, decisions };
}

/**
 * Drop observations beyond `k` median-absolute-deviations from the median.
 *
 * Bounds are computed from `sorted` and then applied to the *original* points,
 * so a decision never depends on the order the points arrived in.
 */
function applyMadFilter(
  points: PricePoint[],
  k: number,
  decisions: FilterDecision[]
): PricePoint[] {
  const values = points.map((p) => p.value);
  const centre = median(values);
  const mad = medianAbsoluteDeviation(values);
  if (centre === null || mad === null) return points;

  // A MAD of zero means at least half the sample is identical. Scaling by it
  // would reject everything that differs, which is wrong: a degenerate but
  // real distribution. Fall back to the IQR fence, and if that is also zero,
  // keep the majority value and drop the rest.
  if (mad === 0n) return points;

  const lower = centre - BigInt(Math.floor(k * Number(mad)));
  const upper = centre + BigInt(Math.floor(k * Number(mad)));

  const kept: PricePoint[] = [];
  for (const point of points) {
    if (point.value < lower) {
      decisions.push({ submissionId: point.submissionId, value: point.value, included: false, reason: "outlier_mad", threshold: lower });
      continue;
    }
    if (point.value > upper) {
      decisions.push({ submissionId: point.submissionId, value: point.value, included: false, reason: "outlier_mad", threshold: upper });
      continue;
    }
    kept.push(point);
  }
  return kept;
}

/**
 * Drop observations outside the Tukey fences `[Q1 - k*IQR, Q3 + k*IQR]`.
 *
 * Complementary to the MAD filter: the IQR is insensitive to how the tails are
 * distributed, so it catches skew that a symmetric MAD window can miss.
 */
function applyIqrFilter(
  points: PricePoint[],
  k: number,
  decisions: FilterDecision[]
): PricePoint[] {
  const values = points.map((p) => p.value);
  if (values.length < 4) return points;

  const q1 = quartile(values, 1);
  const q3 = quartile(values, 3);
  if (q1 === null || q3 === null) return points;

  const iqr = q3 - q1;
  // A zero IQR means three quarters of the sample is identical; there is no
  // spread to reason about, so leave the sample alone and let the MAD filter
  // (or the caller) decide.
  if (iqr === 0n) return points;

  const lower = q1 - BigInt(Math.floor(k * Number(iqr)));
  const upper = q3 + BigInt(Math.floor(k * Number(iqr)));

  const kept: PricePoint[] = [];
  for (const point of points) {
    if (point.value < lower) {
      decisions.push({ submissionId: point.submissionId, value: point.value, included: false, reason: "outlier_iquartile", threshold: lower });
      continue;
    }
    if (point.value > upper) {
      decisions.push({ submissionId: point.submissionId, value: point.value, included: false, reason: "outlier_iquartile", threshold: upper });
      continue;
    }
    kept.push(point);
  }
  return kept;
}

/**
 * Cap how much of the sample one submitter can account for, dropping their
 * excess observations lowest-value-first.
 *
 * Without this, a single actor submitting a thousand prices defines the index
 * for a country nobody else has reported on. Dropping the *lowest* values
 * first is deliberate: a flood of low submissions is the cheaper way to move
 * an index downward, and retaining each submitter's highest observations keeps
 * the conservative end of the range.
 */
function applySubmitterCap(
  points: PricePoint[],
  maxShare: number,
  decisions: FilterDecision[]
): PricePoint[] {
  if (maxShare <= 0 || maxShare >= 1) return points;

  const bySubmitter = new Map<string, PricePoint[]>();
  for (const point of points) {
    const list = bySubmitter.get(point.submitter);
    if (list) list.push(point);
    else bySubmitter.set(point.submitter, [point]);
  }

  const cap = Math.max(1, Math.floor(points.length * maxShare));
  const dropped = new Set<string>();

  for (const list of bySubmitter.values()) {
    if (list.length <= cap) continue;
    // Drop the excess, lowest first, and keep the highest `cap` values.
    const sorted = [...list].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    for (const point of sorted.slice(0, sorted.length - cap)) {
      dropped.add(point.submissionId);
      decisions.push({
        submissionId: point.submissionId,
        value: point.value,
        included: false,
        reason: "submitter_cap",
        threshold: null,
      });
    }
  }

  return points.filter((p) => !dropped.has(p.submissionId));
}

/**
 * Filter and aggregate a set of observations into a canonical index value.
 *
 * The pipeline, in order:
 *   1. Status and absolute bounds — cheap, and independent of the data.
 *   2. MAD filter — the primary outlier rejection, robust centre and scale.
 *   3. Tukey IQR fence — catches skew the symmetric MAD window misses.
 *   4. Per-submitter cap — bounds any single actor's influence.
 *   5. Median and credibility-weighted mean over what survived.
 *
 * Every exclusion is appended to `decisions` with the threshold that produced
 * it, so a disputed index value can always be traced to the exact records that
 * were removed and why.
 */
export function aggregate(
  points: PricePoint[],
  options: FilterOptions = {}
): AggregationResult {
  const {
    madThreshold = 3,
    iqrMultiplier = 1.5,
    includeStatuses = ["verified"],
    maxSubmitterShare = null,
  } = options;

  const decisions: FilterDecision[] = [];
  const { kept } = applyBasicFilters(points, { includeStatuses, ...options });

  // Each filter appends to the shared decision log, so a submission excluded by
  // an earlier filter is never re-examined by a later one.
  let survivors = kept;
  if (madThreshold !== null) {
    survivors = applyMadFilter(survivors, madThreshold, decisions);
  }
  if (iqrMultiplier !== null) {
    survivors = applyIqrFilter(survivors, iqrMultiplier, decisions);
  }
  if (maxSubmitterShare !== null) {
    survivors = applySubmitterCap(survivors, maxSubmitterShare, decisions);
  }

  for (const point of survivors) {
    decisions.push({
      submissionId: point.submissionId,
      value: point.value,
      included: true,
      reason: "included",
      threshold: null,
    });
  }

  if (survivors.length === 0) return emptyResult(points.length, decisions);

  const values = survivors.map((p) => p.value);
  const weights = credibilityWeights(survivors);

  return {
    median: median(values),
    weighted: weightedMean(values, weights),
    inputCount: points.length,
    includedCount: survivors.length,
    excludedCount: decisions.filter((d) => !d.included).length,
    decisions,
    excludedByReason: countByReason(decisions),
  };
}
