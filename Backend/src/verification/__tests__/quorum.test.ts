import {
  DEFAULT_QUORUM_CONFIG,
  evaluateQuorum,
  hasQuorum,
  meetsRatio,
  resolveActiveVotes,
  withinRatio,
  type QuorumVote,
} from "../quorum";

/** Build a vote list from (voter, choice) pairs, all active. */
function votes(...pairs: Array<[string, "approve" | "reject"]>): QuorumVote[] {
  return pairs.map(([voter, choice], i) => ({
    voter,
    choice,
    votedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
  }));
}

describe("exact ratio comparison", () => {
  it("compares in integer arithmetic so boundaries land predictably", () => {
    // 2/3 >= 2/3 must be true. Computed as doubles this is a coin flip
    // depending on rounding; cross-multiplied it is 6 >= 6.
    expect(meetsRatio(2, 3, { numerator: 2, denominator: 3 })).toBe(true);
    expect(meetsRatio(1, 3, { numerator: 2, denominator: 3 })).toBe(false);
  });

  it("does not award a passing ratio to an empty set", () => {
    // Every `0 >= 0` comparison is true, so a zero-vote submission would
    // otherwise clear any ratio whose numerator is 0.
    expect(meetsRatio(0, 0, { numerator: 0, denominator: 1 })).toBe(false);
    expect(withinRatio(0, 0, { numerator: 1, denominator: 3 })).toBe(true);
  });

  it("mirrors meetsRatio for ceilings", () => {
    expect(withinRatio(1, 3, { numerator: 1, denominator: 3 })).toBe(true);
    expect(withinRatio(2, 3, { numerator: 1, denominator: 3 })).toBe(false);
  });
});

describe("evaluateQuorum", () => {
  it("does not verify a submission on a single approving vote", () => {
    // The reason this module exists: a 1/1 approval ratio is a perfect score
    // and must still fail, because nobody else has looked at it.
    const result = evaluateQuorum(votes(["alice", "approve"]));

    expect(result.passed).toBe(false);
    expect(result.decided).toBe(false);
    expect(result.reason).toBe("insufficient_voters");
  });

  it("reports no_active_votes for an empty set", () => {
    const result = evaluateQuorum([]);

    expect(result.passed).toBe(false);
    expect(result.decided).toBe(false);
    expect(result.reason).toBe("no_active_votes");
    expect(result.totalActive).toBe(0);
  });

  it("verifies at exactly the default threshold", () => {
    const result = evaluateQuorum(
      votes(["alice", "approve"], ["bob", "approve"], ["carol", "reject"])
    );

    expect(result.totalActive).toBe(3);
    expect(result.approvals).toBe(2);
    expect(result.requiredApprovals).toBe(2);
    expect(result.passed).toBe(true);
    expect(result.reason).toBe("approved");
  });

  it("fails a full vote set that is short on approvals", () => {
    const result = evaluateQuorum(
      votes(["alice", "approve"], ["bob", "reject"], ["carol", "reject"])
    );

    expect(result.decided).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("approval_below_threshold");
  });

  it("reports the requiredApprovals needed at the current voter count", () => {
    const result = evaluateQuorum(votes(["alice", "approve"], ["bob", "approve"]));

    expect(result.decided).toBe(false);
    // 2 voters * 2/3 rounds up to 2, so these two approvals would be enough —
    // if there were a third voter to make it a quorum.
    expect(result.requiredApprovals).toBe(2);
  });

  it("excludes inactive votes from every count", () => {
    const result = evaluateQuorum([
      { voter: "alice", choice: "approve" },
      { voter: "bob", choice: "approve" },
      { voter: "carol", choice: "approve", active: false },
    ]);

    expect(result.totalActive).toBe(2);
    expect(result.approvals).toBe(2);
    expect(result.decided).toBe(false);
  });

  it("lets a retracted approval drop a submission below quorum", () => {
    const submitted: QuorumVote[] = votes(
      ["alice", "approve"],
      ["bob", "approve"],
      ["carol", "approve"]
    );
    expect(evaluateQuorum(submitted).passed).toBe(true);

    const retracted: QuorumVote[] = [
      ...submitted.slice(0, 2),
      { ...submitted[2], active: false },
    ];
    expect(evaluateQuorum(retracted).decided).toBe(false);
  });

  it("honours a custom threshold", () => {
    const five = votes(
      ["a", "approve"],
      ["b", "approve"],
      ["c", "approve"],
      ["d", "approve"],
      ["e", "reject"]
    );

    expect(
      evaluateQuorum(five, { minVoters: 3, approvalRatio: { numerator: 2, denominator: 3 } }).passed
    ).toBe(true);
    // Four of five is exactly 4/5, so it clears a 4/5 bar...
    expect(
      evaluateQuorum(five, { minVoters: 3, approvalRatio: { numerator: 4, denominator: 5 } }).passed
    ).toBe(true);
    // ...but not a 5/6 one. The boundary is exact rather than approximate,
    // which is the property that makes a vote set reproducible.
    expect(
      evaluateQuorum(five, { minVoters: 3, approvalRatio: { numerator: 5, denominator: 6 } }).passed
    ).toBe(false);
  });

  it("fails a submission whose dissent exceeds the ceiling", () => {
    // Approval ratio is loosened so only the rejection ceiling can fail this.
    const result = evaluateQuorum(
      votes(
        ["a", "approve"],
        ["b", "approve"],
        ["c", "approve"],
        ["d", "reject"],
        ["e", "reject"]
      ),
      {
        minVoters: 3,
        approvalRatio: { numerator: 1, denominator: 2 },
        rejectionCeiling: { numerator: 1, denominator: 3 },
      }
    );

    expect(result.reason).toBe("rejection_above_ceiling");
    expect(result.decided).toBe(true);
  });

  it("rejects a nonsensical configuration loudly", () => {
    expect(() => evaluateQuorum([], { minVoters: 0 })).toThrow(/minVoters/);
    expect(() => evaluateQuorum([], { approvalRatio: { numerator: 1, denominator: 0 } })).toThrow(
      /denominator/
    );
  });
});

describe("determinism", () => {
  it("returns the same result for the same votes in any order", () => {
    const base: QuorumVote[] = [
      { voter: "alice", choice: "approve", votedAt: "2026-01-01T00:00:00Z" },
      { voter: "bob", choice: "reject", votedAt: "2026-01-01T00:00:01Z" },
      { voter: "carol", choice: "approve", votedAt: "2026-01-01T00:00:02Z" },
    ];

    const forward = evaluateQuorum(base);
    const reversed = evaluateQuorum([...base].reverse());
    const rotated = evaluateQuorum([base[1], base[2], base[0]]);

    expect(reversed).toEqual(forward);
    expect(rotated).toEqual(forward);
  });

  it("exposes the resolved config so a caller can report the rule applied", () => {
    const result = evaluateQuorum(votes(["a", "approve"]));

    expect(result.minVoters).toBe(DEFAULT_QUORUM_CONFIG.minVoters);
    expect(result.approvalRatio).toEqual(DEFAULT_QUORUM_CONFIG.approvalRatio);
  });
});

describe("resolveActiveVotes", () => {
  it("counts a duplicated voter once", () => {
    const resolved = resolveActiveVotes([
      { voter: "alice", choice: "approve", votedAt: "2026-01-01T00:00:00Z" },
      { voter: "alice", choice: "approve", votedAt: "2026-01-01T00:00:05Z" },
    ]);

    expect(resolved).toHaveLength(1);
  });

  it("keeps the most recent vote from a voter who changed their mind", () => {
    const resolved = resolveActiveVotes([
      { voter: "alice", choice: "approve", votedAt: "2026-01-01T00:00:00Z" },
      { voter: "alice", choice: "reject", votedAt: "2026-01-01T00:00:09Z" },
    ]);

    expect(resolved[0].choice).toBe("reject");
  });

  it("resolves identical timestamps the same way regardless of array order", () => {
    const forwards: QuorumVote[] = [
      { voter: "alice", choice: "approve", votedAt: "2026-01-01T00:00:00Z" },
      { voter: "alice", choice: "reject", votedAt: "2026-01-01T00:00:00Z" },
    ];
    const backwards = [forwards[1], forwards[0]];

    expect(resolveActiveVotes(forwards)).toEqual(resolveActiveVotes(backwards));
  });

  it("drops inactive entries entirely", () => {
    const resolved = resolveActiveVotes([
      { voter: "alice", choice: "approve", active: false },
      { voter: "bob", choice: "approve" },
    ]);

    expect(resolved.map((v) => v.voter)).toEqual(["bob"]);
  });

  it("returns a stable order", () => {
    const resolved = resolveActiveVotes([
      { voter: "carol", choice: "approve" },
      { voter: "alice", choice: "approve" },
      { voter: "bob", choice: "approve" },
    ]);

    expect(resolved.map((v) => v.voter)).toEqual(["alice", "bob", "carol"]);
  });
});

describe("hasQuorum", () => {
  it("answers whether a verdict is possible yet", () => {
    expect(hasQuorum(votes(["a", "approve"]))).toBe(false);
    expect(hasQuorum(votes(["a", "approve"], ["b", "approve"], ["c", "approve"]))).toBe(true);
  });
});

describe("typed quorum outcome (BE-040)", () => {
  it("reports insufficient with the number of votes still needed", () => {
    expect(evaluateQuorum([]).outcome).toEqual({ status: "insufficient", votesNeeded: 3 });
    expect(evaluateQuorum(votes(["a", "approve"])).outcome).toEqual({ status: "insufficient", votesNeeded: 2 });
    expect(evaluateQuorum(votes(["a", "approve"], ["b", "approve"])).outcome).toEqual({
      status: "insufficient",
      votesNeeded: 1,
    });
  });

  it("does not report a flattering ratio on too few votes as anything but insufficient", () => {
    const result = evaluateQuorum(votes(["a", "approve"]));
    expect(result.outcome.status).toBe("insufficient");
    expect(result.passed).toBe(false);
  });

  it("reports satisfied exactly at the default threshold", () => {
    const result = evaluateQuorum(votes(["a", "approve"], ["b", "approve"], ["c", "reject"]));
    // 2 of 3 approve is exactly the threshold; 1 of 3 reject is exactly the ceiling.
    expect(result.outcome).toEqual({ status: "satisfied" });
    expect(result.passed).toBe(true);
  });

  it("reports conflicting when approvals and rejections both exist and the split fails", () => {
    const result = evaluateQuorum(votes(["a", "approve"], ["b", "reject"], ["c", "reject"]));
    expect(result.outcome).toEqual({ status: "conflicting", approvals: 1, rejections: 2, approvalsShort: 1 });
    expect(result.decided).toBe(true);
  });

  it("reports rejected, not conflicting, when nobody approves", () => {
    const result = evaluateQuorum(votes(["a", "reject"], ["b", "reject"], ["c", "reject"]));
    expect(result.outcome).toEqual({ status: "rejected", rejections: 3 });
  });

  it("is conflicting for a rejection ceiling breach even when approval threshold is met", () => {
    const result = evaluateQuorum(votes(["a", "approve"], ["b", "reject"], ["c", "reject"]), {
      approvalRatio: { numerator: 1, denominator: 3 },
    });
    expect(result.reason).toBe("rejection_above_ceiling");
    expect(result.outcome.status).toBe("conflicting");
  });

  it("leaves the existing pass/fail policy untouched", () => {
    const passing = evaluateQuorum(votes(["a", "approve"], ["b", "approve"], ["c", "approve"]));
    expect(passing).toMatchObject({ passed: true, decided: true, reason: "approved" });
    const short = evaluateQuorum(votes(["a", "approve"], ["b", "reject"], ["c", "reject"]));
    expect(short).toMatchObject({ passed: false, decided: true, reason: "approval_below_threshold" });
  });
});
