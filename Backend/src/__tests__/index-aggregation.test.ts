/**
 * Unit tests for the robust index computation (#652, #653).
 *
 * These are pure-function tests — no database, no network. They cover the
 * properties the aggregation is supposed to guarantee, rather than
 * implementation details: that a median is unmoved by a minority of absurd
 * inputs, that a weighted mean does reward corroboration without letting volume
 * dominate, and that every exclusion is recorded with the threshold that
 * caused it.
 */

import {
  aggregate,
  median,
  quartile,
  medianAbsoluteDeviation,
  weightedMean,
  credibilityWeights,
  PricePoint,
} from "../analytics/index-aggregation";

/** Build a verified observation with a distinct submitter per point. */
function point(
  id: string,
  value: bigint,
  overrides: Partial<PricePoint> = {}
): PricePoint {
  return {
    submissionId: id,
    value,
    submitter: `G${id.padStart(50, "0")}`,
    status: "verified",
    timestamp: 1_700_000_000,
    ...overrides,
  };
}

describe("median (#652)", () => {
  it("returns the central value for an odd-sized sample", () => {
    expect(median([5n, 1n, 3n])).toBe(3n);
  });

  it("averages the two central values for an even-sized sample", () => {
    expect(median([1n, 2n, 3n, 4n])).toBe(2n);
  });

  it("truncates a half-integer median rather than rounding up", () => {
    // Rounding up would systematically overstate the cost of living.
    expect(median([1n, 2n])).toBe(1n);
  });

  it("returns null for an empty sample", () => {
    expect(median([])).toBeNull();
  });

  it("is unmoved by a single extreme value, unlike a mean", () => {
    const honest = [100n, 110n, 105n, 115n, 108n];
    const poisoned = [...honest, 1_000_000n];
    expect(median(poisoned)).toBe(median(honest));
  });

  it("does not mutate the input array", () => {
    const values = [3n, 1n, 2n];
    median(values);
    expect(values).toEqual([3n, 1n, 2n]);
  });
});

describe("quartile and median absolute deviation", () => {
  it("computes the first quartile of a small sample", () => {
    expect(quartile([1n, 2n, 3n, 4n, 5n], 1)).toBe(2n);
  });

  it("computes the third quartile of a small sample", () => {
    expect(quartile([1n, 2n, 3n, 4n, 5n], 3)).toBe(4n);
  });

  it("returns null quartiles for an empty sample", () => {
    expect(quartile([], 1)).toBeNull();
    expect(quartile([], 3)).toBeNull();
  });

  it("computes the deviation from the median", () => {
    // median = 3, deviations = [2, 1, 0, 1, 2], median of those = 1
    expect(medianAbsoluteDeviation([1n, 2n, 3n, 4n, 5n])).toBe(1n);
  });

  it("is not inflated by the outlier it exists to detect", () => {
    const clean = [10n, 10n, 10n, 10n, 10n];
    // The whole point of using MAD over standard deviation: a huge outlier
    // must not inflate the scale that judges it.
    expect(
      medianAbsoluteDeviation([...clean, 1_000_000n])
    ).toBe(medianAbsoluteDeviation(clean));
  });
});

describe("credibility-weighted mean (#652)", () => {
  it("returns null for mismatched input lengths", () => {
    expect(weightedMean([1n, 2n], [1])).toBeNull();
  });

  it("returns null when every weight is zero", () => {
    expect(weightedMean([1n, 2n], [0, 0])).toBeNull();
  });

  it("equals a plain mean when all weights are equal", () => {
    expect(weightedMean([10n, 20n], [1, 1])).toBe(15n);
  });

  it("moves toward the more heavily weighted value", () => {
    // Weight 9:1 pulls the result toward 100n.
    const result = weightedMean([10n, 100n], [9, 1]);
    expect(result).toBeGreaterThan(15n);
    expect(result).toBeLessThan(100n);
  });

  it("rewards a corroborated submitter, but sublinearly", () => {
    // Per-observation the active submitter carries less weight, but their four
    // observations together must outweigh the lone one (corroboration is the
    // point of crowdsourcing) — yet not 4x as much, or volume alone would
    // decide the index.
    const weights = credibilityWeights([
      point("a1", 100n, { submitter: "G-active" }),
      point("a2", 100n, { submitter: "G-active" }),
      point("a3", 100n, { submitter: "G-active" }),
      point("a4", 100n, { submitter: "G-active" }),
      point("b1", 100n, { submitter: "G-solo" }),
    ]);
    const activeTotal = weights[0] + weights[1] + weights[2] + weights[3];
    const soloTotal = weights[4];
    expect(activeTotal).toBeGreaterThan(soloTotal);
    expect(activeTotal).toBeLessThan(soloTotal * 4);
    // A submitter's repeat observations are individually discounted.
    expect(weights[0]).toBeLessThan(weights[4]);
  });

  it("gives a lone submitter the full weight of any other lone submitter", () => {
    const weights = credibilityWeights([
      point("a1", 100n, { submitter: "G-one" }),
      point("b1", 100n, { submitter: "G-two" }),
    ]);
    expect(weights[0]).toBe(weights[1]);
  });
});

describe("filtering (#653)", () => {
  it("excludes a non-positive value as invalid", () => {
    const result = aggregate([point("a", 100n), point("b", 0n)]);
    expect(result.includedCount).toBe(1);
    const decision = result.decisions.find((d) => d.submissionId === "b");
    expect(decision?.included).toBe(false);
    expect(decision?.reason).toBe("invalid_value");
  });

  it("excludes a rejected submission and records the status reason", () => {
    const result = aggregate([
      point("a", 100n),
      point("b", 100n, { status: "rejected" }),
    ]);
    const decision = result.decisions.find((d) => d.submissionId === "b");
    expect(decision?.reason).toBe("rejected_status");
  });

  it("excludes a pending submission by default", () => {
    const result = aggregate([
      point("a", 100n),
      point("b", 100n, { status: "pending" }),
    ]);
    expect(result.includedCount).toBe(1);
    expect(result.decisions.find((d) => d.submissionId === "b")?.reason).toBe(
      "pending_status"
    );
  });

  it("includes a pending submission when asked to", () => {
    const result = aggregate([point("a", 100n, { status: "pending" })], {
      includeStatuses: ["verified", "pending"],
    });
    expect(result.includedCount).toBe(1);
  });

  it("enforces an absolute ceiling and records the threshold", () => {
    const result = aggregate([point("a", 100n), point("b", 10_000n)], {
      maxValue: 1_000n,
    });
    const decision = result.decisions.find((d) => d.submissionId === "b");
    expect(decision?.included).toBe(false);
    expect(decision?.reason).toBe("above_maximum");
    expect(decision?.threshold).toBe(1_000n);
  });

  it("excludes a gross outlier via the MAD filter", () => {
    const result = aggregate(
      [point("a", 100n), point("b", 102n), point("c", 98n), point("d", 101n), point("e", 5_000_000n)],
      { madThreshold: 3 }
    );
    const decision = result.decisions.find((d) => d.submissionId === "e");
    expect(decision?.included).toBe(false);
    expect(["outlier_mad", "outlier_iquartile"]).toContain(decision?.reason);
    expect(result.includedCount).toBe(4);
  });

  it("keeps every observation when the sample is too small to judge", () => {
    // Three identical values have no spread; rejecting a genuine observation
    // because there is not enough data to judge it would be worse than
    // publishing it.
    const result = aggregate([point("a", 100n), point("b", 100n), point("c", 100n)]);
    expect(result.includedCount).toBe(3);
  });

  it("caps one submitter's share of the sample", () => {
    const points = [
      point("a1", 10n, { submitter: "G-flood" }),
      point("a2", 10n, { submitter: "G-flood" }),
      point("a3", 10n, { submitter: "G-flood" }),
      point("a4", 10n, { submitter: "G-flood" }),
      point("b1", 10_000n, { submitter: "G-real" }),
    ];
    const result = aggregate(points, { maxSubmitterShare: 0.5, madThreshold: null, iqrMultiplier: null });
    // The flooder is capped; the real submitter is not.
    expect(result.includedCount).toBeLessThan(points.length);
    const capped = result.decisions.filter((d) => d.reason === "submitter_cap");
    expect(capped.length).toBeGreaterThan(0);
    expect(result.decisions.find((d) => d.submissionId === "b1")?.included).toBe(true);
  });

  it("drops a flooder's lowest values first", () => {
    const points = [
      point("a1", 1n, { submitter: "G-flood" }),
      point("a2", 2n, { submitter: "G-flood" }),
      point("a3", 3n, { submitter: "G-flood" }),
      point("a4", 4n, { submitter: "G-flood" }),
      point("b1", 10_000n, { submitter: "G-real" }),
    ];
    const result = aggregate(points, {
      maxSubmitterShare: 0.5,
      madThreshold: null,
      iqrMultiplier: null,
    });
    // The retained part of the flood is its high end, so the conservative
    // reading of that submitter's prices survives.
    const droppedIds = result.decisions
      .filter((d) => d.reason === "submitter_cap")
      .map((d) => d.submissionId);
    expect(droppedIds).toEqual(["a1", "a2"]);
    expect(result.decisions.find((d) => d.submissionId === "a4")?.included).toBe(true);
  });
});

describe("aggregate (#652, #653)", () => {
  it("returns nulls and a full audit trail when nothing survives", () => {
    const result = aggregate([point("a", 0n), point("b", 0n)]);
    expect(result.median).toBeNull();
    expect(result.weighted).toBeNull();
    expect(result.includedCount).toBe(0);
    expect(result.inputCount).toBe(2);
    expect(result.decisions).toHaveLength(2);
  });

  it("returns nulls for an empty input", () => {
    const result = aggregate([]);
    expect(result.median).toBeNull();
    expect(result.inputCount).toBe(0);
  });

  it("reports input, included, and excluded counts that add up", () => {
    const result = aggregate([
      point("a", 100n),
      point("b", 102n),
      point("c", 0n),
      point("d", 101n, { status: "rejected" }),
    ]);
    expect(result.inputCount).toBe(4);
    expect(result.includedCount + result.excludedCount).toBe(4);
  });

  it("breaks down exclusions by reason", () => {
    const result = aggregate([
      point("a", 100n),
      point("b", 0n),
      point("c", 0n),
      point("d", 5n, { status: "rejected" }),
    ]);
    expect(result.excludedByReason.invalid_value).toBe(2);
    expect(result.excludedByReason.rejected_status).toBe(1);
    expect(result.excludedByReason.included).toBe(1);
  });

  it("is deterministic: the same input yields the same median", () => {
    const points = [point("a", 100n), point("b", 110n), point("c", 105n)];
    const first = aggregate(points);
    const second = aggregate([...points].reverse());
    expect(second.median).toBe(first.median);
  });

  it("publishes a median that an outlier cannot move", () => {
    const honest = [point("a", 100n), point("b", 102n), point("c", 101n)];
    const poisoned = [...honest, point("x", 900_000_000n)];
    const before = aggregate(honest);
    const after = aggregate(poisoned);
    // The outlier is excluded, so the published index is unchanged.
    expect(after.median).toBe(before.median);
  });

  it("always records a decision for every input observation", () => {
    const points = [
      point("a", 100n),
      point("b", 0n),
      point("c", 5n, { status: "rejected" }),
    ];
    const result = aggregate(points);
    expect(result.decisions).toHaveLength(points.length);
  });
});
