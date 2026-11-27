/**
 * Unit tests for reward calculation (#656) and the audit hash chain (#658).
 *
 * Both modules are pure by design — rewards read no clock and no global, and
 * the chain is a pure function of its inputs — so these need no database and
 * no mocks. The properties asserted are the ones the issues actually name:
 * reproducibility, duplicate-vote handling, rejected data, and tamper
 * detection.
 */

import {
  assessBatch,
  assessSubmission,
  dedupeVerifications,
  isValidAddress,
  DEFAULT_REWARD_RULES,
  SubmissionRecord,
  VerificationRecord,
} from "../rewards/rules";
import {
  GENESIS_HASH,
  canonicalize,
  chainEntry,
  hashEntry,
  verifyChain,
  actorKeyOf,
  AuditEntryInput,
} from "../audit/chain";
import { RewardStore } from "../rewards/store";

/** A well-formed Stellar address, so address validation is not the subject. */
const ALICE = `G${"A".repeat(55)}`;
const BOB = `G${"B".repeat(55)}`;
const CAROL = `G${"C".repeat(55)}`;

function submission(overrides: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    submissionId: "s1",
    submitter: ALICE,
    status: "verified",
    corroborations: 0,
    ...overrides,
  };
}

function verify(
  submissionId: string,
  verifier: string,
  verdict: VerificationRecord["verdict"] = "approve"
): VerificationRecord {
  return { submissionId, verifier, verdict };
}

describe("isValidAddress", () => {
  it("accepts a 56-character G-prefixed base32 address", () => {
    expect(isValidAddress(ALICE)).toBe(true);
  });

  it("rejects a short string", () => {
    expect(isValidAddress("GALICE")).toBe(false);
  });

  it("rejects a lowercase address", () => {
    expect(isValidAddress(ALICE.toLowerCase())).toBe(false);
  });

  it("rejects a character outside the base32 alphabet", () => {
    expect(isValidAddress(`G${"0".repeat(55)}`)).toBe(false);
  });
});

describe("assessSubmission (#656)", () => {
  it("pays the base reward for a verified submission", () => {
    const result = assessSubmission(submission(), []);
    expect(result.total).toBe(DEFAULT_REWARD_RULES.baseSubmissionReward);
    expect(result.accruals).toHaveLength(1);
    expect(result.accruals[0].address).toBe(ALICE);
    expect(result.accruals[0].state).toBe("claimable");
  });

  it("pays a verifier for approving", () => {
    const result = assessSubmission(submission(), [verify("s1", BOB)]);
    const verifierLine = result.accruals.find((a) => a.address === BOB);
    expect(verifierLine?.amount).toBe(DEFAULT_REWARD_RULES.verificationReward);
  });

  it("pays nothing for a rejected submission", () => {
    // Not even the rejection reward: rejecting bad data is a cost the protocol
    // bears, not a paid service.
    const result = assessSubmission(
      submission({ status: "rejected" }),
      [verify("s1", BOB, "reject")]
    );
    expect(result.total).toBe(0n);
    expect(result.accruals).toEqual([]);
  });

  it("pays nothing for a pending submission", () => {
    const result = assessSubmission(submission({ status: "pending" }), [verify("s1", BOB)]);
    expect(result.total).toBe(0n);
  });

  it("applies the corroboration bonus above the threshold", () => {
    const uncorroborated = assessSubmission(submission({ corroborations: 0 }), []);
    const corroborated = assessSubmission(
      submission({ corroborations: DEFAULT_REWARD_RULES.corroborationThreshold }),
      []
    );
    expect(corroborated.total).toBeGreaterThan(uncorroborated.total);
  });

  it("does not apply the bonus below the threshold", () => {
    const below = assessSubmission(
      submission({ corroborations: DEFAULT_REWARD_RULES.corroborationThreshold - 1 }),
      []
    );
    const none = assessSubmission(submission({ corroborations: 0 }), []);
    expect(below.total).toBe(none.total);
  });

  it("caps the corroboration bonus so a colluding group cannot scale it without limit", () => {
    const rules = DEFAULT_REWARD_RULES;
    const atCap = assessSubmission(submission({ corroborations: 8 }), [], rules);
    const farBeyond = assessSubmission(submission({ corroborations: 10_000 }), [], rules);
    // Colluding 10,000 times earns no more than 8 agreeing reports.
    expect(farBeyond.total).toBe(atCap.total);
  });

  it("holds a flagged submission's reward as pending", () => {
    const result = assessSubmission(submission({ flagged: true }), []);
    expect(result.accruals[0].state).toBe("pending");
    // Reduced, not zeroed: the work was real and review may still clear it.
    expect(result.total).toBeGreaterThan(0n);
    expect(result.total).toBeLessThan(DEFAULT_REWARD_RULES.baseSubmissionReward);
  });

  it("reproduces the same total for the same input", () => {
    const verifications = [verify("s1", BOB), verify("s1", CAROL)];
    const first = assessSubmission(submission({ corroborations: 4 }), verifications);
    const second = assessSubmission(submission({ corroborations: 4 }), verifications);
    expect(second.total).toBe(first.total);
    expect(second.accruals).toEqual(first.accruals);
  });

  it("ignores a verifier approving a different submission", () => {
    const result = assessSubmission(submission(), [verify("s2", BOB)]);
    expect(result.accruals.find((a) => a.address === BOB)).toBeUndefined();
  });

  it("rejects a self-verification", () => {
    const result = assessSubmission(submission(), [verify("s1", ALICE)]);
    expect(result.accruals.find((a) => a.address === ALICE && a.kind === "verification")).toBeUndefined();
    expect(result.ignoredVerifications).toContainEqual({
      verifier: ALICE,
      reason: "self_verification",
    });
  });

  it("pays a verifier who approved, once", () => {
    const single = assessSubmission(submission(), [verify("s1", BOB)]);
    const repeated = assessSubmission(submission(), [verify("s1", BOB), verify("s1", BOB)]);
    expect(repeated.total).toBe(single.total);
  });
});

describe("duplicate votes (#656 edge case)", () => {
  it("dedupes repeated votes by the same verifier", () => {
    const { unique, duplicates } = dedupeVerifications([
      verify("s1", BOB),
      verify("s1", BOB),
      verify("s1", CAROL),
    ]);
    expect(unique).toHaveLength(2);
    expect(duplicates).toHaveLength(1);
  });

  it("keeps the first vote and records the repeat as ignored", () => {
    const result = assessSubmission(submission(), [
      verify("s1", BOB),
      verify("s1", BOB, "reject"),
    ]);
    // The later reject does not convert an approval into a rejection: letting a
    // verifier change their vote after seeing the reward would make the reward a
    // function of when they looked rather than of the data.
    expect(result.accruals.find((a) => a.address === BOB && a.kind === "verification")).toBeDefined();
    expect(result.ignoredVerifications).toContainEqual({ verifier: BOB, reason: "duplicate_vote" });
  });

  it("does not treat the same verifier on different submissions as a duplicate", () => {
    const { unique } = dedupeVerifications([verify("s1", BOB), verify("s2", BOB)]);
    expect(unique).toHaveLength(2);
  });

  it("pays a double voter exactly once", () => {
    const once = assessSubmission(submission(), [verify("s1", BOB)]);
    const twice = assessSubmission(submission(), [
      verify("s1", BOB),
      verify("s1", BOB),
      verify("s1", BOB),
    ]);
    expect(twice.total).toBe(once.total);
  });
});

describe("assessBatch (#657 totals)", () => {
  it("merges what one address is owed across submissions", () => {
    const { byAddress } = assessBatch(
      [submission({ submissionId: "s1" }), submission({ submissionId: "s2" })],
      [verify("s1", BOB), verify("s2", BOB)]
    );
    // Two base rewards plus two verification rewards.
    expect(byAddress.get(ALICE)?.total).toBe(
      DEFAULT_REWARD_RULES.baseSubmissionReward * 2n
    );
    expect(byAddress.get(BOB)?.total).toBe(DEFAULT_REWARD_RULES.verificationReward * 2n);
  });

  it("separates held from claimable", () => {
    const { byAddress } = assessBatch(
      [submission({ submissionId: "s1", flagged: true }), submission({ submissionId: "s2" })],
      []
    );
    const alice = byAddress.get(ALICE);
    expect(alice?.pending).toBeGreaterThan(0n);
    expect(alice?.claimable).toBeGreaterThan(0n);
    expect(alice?.total).toBe(alice!.pending + alice!.claimable);
  });

  it("reports an empty map for no submissions", () => {
    const { byAddress } = assessBatch([], []);
    expect(byAddress.size).toBe(0);
  });
});

describe("audit chain (#658)", () => {
  function entry(overrides: Partial<AuditEntryInput> = {}): AuditEntryInput {
    return {
      stream: "contract:C1",
      action: "event.processed",
      actor: { kind: "system", component: "indexer" },
      outcome: "success",
      subject: "C1",
      ledger: 100,
      transactionHash: "abc",
      metadata: { event_id: "e1" },
      occurredAt: new Date("2024-01-01T00:00:00.000Z"),
      ...overrides,
    };
  }

  it("hashes deterministically", () => {
    expect(hashEntry(entry(), GENESIS_HASH)).toBe(hashEntry(entry(), GENESIS_HASH));
  });

  it("produces different hashes for different previous hashes", () => {
    expect(hashEntry(entry(), GENESIS_HASH)).not.toBe(hashEntry(entry(), "f".repeat(64)));
  });

  it("is insensitive to metadata key order", () => {
    const a = hashEntry(entry({ metadata: { x: 1, y: 2 } }), GENESIS_HASH);
    const b = hashEntry(entry({ metadata: { y: 2, x: 1 } }), GENESIS_HASH);
    // Object key order is not guaranteed across languages; the canonical form
    // must not depend on it or the chain would break for no reason.
    expect(b).toBe(a);
  });

  it("distinguishes metadata that stringifies identically", () => {
    // Without a length prefix, {a: "bc"} and {ab: "c"} can serialise the same
    // and a record could be altered without changing its hash.
    const a = hashEntry(entry({ metadata: { a: "bc" } }), GENESIS_HASH);
    const b = hashEntry(entry({ metadata: { ab: "c" } }), GENESIS_HASH);
    expect(b).not.toBe(a);
  });

  it("distinguishes actors of different kinds", () => {
    const address = canonicalize(entry({ actor: { kind: "address", address: "indexer" } }));
    const system = canonicalize(entry({ actor: { kind: "system", component: "indexer" } }));
    expect(system).not.toBe(address);
  });

  it("verifies an intact chain", () => {
    const a = chainEntry(entry({ metadata: { n: 1 } }), GENESIS_HASH, "a");
    const b = chainEntry(entry({ metadata: { n: 2 } }), a.hash, "b");
    const c = chainEntry(entry({ metadata: { n: 3 } }), b.hash, "c");
    expect(verifyChain([a, b, c]).valid).toBe(true);
  });

  it("detects a modified entry", () => {
    const a = chainEntry(entry({ metadata: { n: 1 } }), GENESIS_HASH, "a");
    const b = chainEntry(entry({ metadata: { n: 2 } }), a.hash, "b");
    // Someone changes the recorded ledger of entry b.
    const tampered = [{ ...a }, { ...b, ledger: 999 }];
    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe("b");
    expect(result.reason).toMatch(/modified/);
  });

  it("detects a removed entry", () => {
    const a = chainEntry(entry({ metadata: { n: 1 } }), GENESIS_HASH, "a");
    const b = chainEntry(entry({ metadata: { n: 2 } }), a.hash, "b");
    const c = chainEntry(entry({ metadata: { n: 3 } }), b.hash, "c");
    // b is deleted: c now points at a hash nothing follows.
    const result = verifyChain([a, c]);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/removed or reordered/);
  });

  it("detects a reordered chain", () => {
    const a = chainEntry(entry({ metadata: { n: 1 } }), GENESIS_HASH, "a");
    const b = chainEntry(entry({ metadata: { n: 2 } }), a.hash, "b");
    expect(verifyChain([b, a]).valid).toBe(false);
  });

  it("verifies an empty chain", () => {
    expect(verifyChain([]).valid).toBe(true);
  });

  it("reports a single-entry chain as valid", () => {
    expect(verifyChain([chainEntry(entry(), GENESIS_HASH, "a")]).valid).toBe(true);
  });

  it("keeps a later stream independent of another", () => {
    const a = chainEntry(entry(), GENESIS_HASH, "a");
    const other = chainEntry(entry({ stream: "contract:C2" }), GENESIS_HASH, "b");
    // Both start at genesis: a per-stream chain, not one global chain.
    expect(verifyChain([other]).valid).toBe(true);
  });
});

describe("actorKeyOf", () => {
  it("prefixes addresses so a filter cannot collide with a system component", () => {
    expect(actorKeyOf({ kind: "address", address: "x" })).toBe("address:x");
    expect(actorKeyOf({ kind: "system", component: "x" })).toBe("system:x");
  });

  it("normalises an unknown actor", () => {
    expect(actorKeyOf({ kind: "unknown" })).toBe("unknown");
  });
});

describe("RewardStore claim transitions (#657 atomicity)", () => {
  function mockClient(responses: Array<{ rows: Record<string, unknown>[] }>) {
    const query = jest.fn();
    for (const response of responses) query.mockResolvedValueOnce(response);
    return { query, release: jest.fn() };
  }

  it("returns an existing claim atomically on idempotent replay", async () => {
    const existing = {
      claim_id: "GA:key",
      address: ALICE,
      amount: "100",
      state: "processing",
      claimed_at: "2026-01-01T00:00:00.000Z",
      completed_at: null,
      transaction_hash: null,
      failure_reason: null,
      idempotency_key: "key",
    };
    const client = mockClient([
      { rows: [] }, // BEGIN
      { rows: [existing] }, // idempotency lookup
      { rows: [] }, // COMMIT
    ]);
    const pool = { connect: jest.fn().mockResolvedValue(client) };

    const store = new RewardStore(pool as never);
    const claim = await store.claim(ALICE, "key");

    expect(claim.claimId).toBe("GA:key");
    expect(client.query.mock.calls[0][0]).toBe("BEGIN");
    expect(client.query.mock.calls[1][0]).toContain("FOR UPDATE");
  });

  it("settles a processing claim once and rolls back the failed transaction", async () => {
    const client = mockClient([
      { rows: [] },
      {
        rows: [{
          claim_id: "GA:key",
          address: ALICE,
          amount: "100",
          state: "failed",
          claimed_at: "2026-01-01T00:00:00.000Z",
          completed_at: "2026-01-01T00:00:01.000Z",
          transaction_hash: null,
          failure_reason: "network",
          idempotency_key: "key",
        }],
      },
      { rows: [] },
      { rows: [] },
    ]);
    const pool = { connect: jest.fn().mockResolvedValue(client) };
    const store = new RewardStore(pool as never);

    await store.settleClaim("GA:key", { state: "failed", failureReason: "network" });

    expect(client.query.mock.calls[0][0]).toBe("BEGIN");
    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).includes("SET state = 'claimable'")
    )).toBe(true);
  });
});
