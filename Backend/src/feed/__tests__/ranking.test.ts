import {
  DEFAULT_FEED_WEIGHTS,
  FeedCandidate,
  FeedValidationError,
  engagementScore,
  parseFeedLimit,
  parseFeedOffset,
  rankFeed,
  validateFeedMode,
} from "../ranking";

const NOW = new Date("2026-09-26T12:00:00.000Z");

function post(overrides: Partial<FeedCandidate> = {}): FeedCandidate {
  return {
    id: 1n,
    author: "GAUTHOR",
    content: "hello",
    tip_total: 0n,
    like_count: 0n,
    created_ledger: 100,
    created_at: NOW,
    deleted_at: null,
    ...overrides,
  };
}

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

describe("engagementScore", () => {
  it("is zero for no engagement", () => {
    expect(engagementScore({ like_count: 0n, tip_total: 0n })).toBe(0);
  });

  it("is monotonic and saturates below 1", () => {
    const small = engagementScore({ like_count: 1n, tip_total: 0n });
    const large = engagementScore({ like_count: 1_000n, tip_total: 0n });
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThanOrEqual(1);
  });
});

describe("rankFeed — recent mode (#676)", () => {
  it("orders newest first regardless of engagement", () => {
    const result = rankFeed(
      [
        post({ id: 1n, created_at: hoursAgo(48), like_count: 10_000n }),
        post({ id: 2n, created_at: hoursAgo(1), like_count: 0n }),
        post({ id: 3n, created_at: hoursAgo(5), like_count: 5n }),
      ],
      { mode: "recent", limit: 10, offset: 0, now: NOW }
    );

    expect(result.entries.map((e) => e.id)).toEqual(["2", "3", "1"]);
  });
});

describe("rankFeed — ranked mode (#676)", () => {
  it("orders by the weighted engagement and recency score", () => {
    // Fresh and moderately engaged should beat old and heavily engaged.
    const result = rankFeed(
      [
        post({ id: 1n, created_at: hoursAgo(24 * 40), like_count: 5_000n }),
        post({ id: 2n, created_at: hoursAgo(2), like_count: 200n }),
      ],
      { mode: "ranked", limit: 10, offset: 0, now: NOW }
    );
    expect(result.entries[0].id).toBe("2");
  });

  it("breaks score ties deterministically by id descending", () => {
    const tied = [
      post({ id: 5n, created_at: NOW, like_count: 7n }),
      post({ id: 9n, created_at: NOW, like_count: 7n }),
    ];
    const a = rankFeed(tied, { mode: "ranked", limit: 10, offset: 0, now: NOW });
    const b = rankFeed([...tied].reverse(), { mode: "ranked", limit: 10, offset: 0, now: NOW });
    expect(a.entries.map((e) => e.id)).toEqual(["9", "5"]);
    expect(b.entries.map((e) => e.id)).toEqual(["9", "5"]);
  });

  it("exposes the signals behind each score", () => {
    const result = rankFeed([post({ like_count: 42n })], {
      mode: "ranked",
      limit: 10,
      offset: 0,
      now: NOW,
    });
    expect(result.entries[0].signals).toHaveProperty("engagement");
    expect(result.entries[0].signals).toHaveProperty("recency");
    expect(result.entries[0].signals.age_hours).toBe(0);
    expect(result.ranking.weights).toEqual(DEFAULT_FEED_WEIGHTS);
    expect(result.ranking.trending_window_days).toBeNull();
  });

  it("drops soft-deleted posts", () => {
    const result = rankFeed(
      [
        post({ id: 1n, like_count: 100n }),
        post({ id: 2n, like_count: 100n, deleted_at: NOW }),
      ],
      { mode: "ranked", limit: 10, offset: 0, now: NOW }
    );
    expect(result.entries.map((e) => e.id)).toEqual(["1"]);
  });

  it("paginates with has_more", () => {
    const posts = [1n, 2n, 3n, 4n, 5n].map((id) => post({ id }));
    const page = rankFeed(posts, { mode: "recent", limit: 2, offset: 0, now: NOW });
    expect(page.entries).toHaveLength(2);
    expect(page.has_more).toBe(true);
    expect(page.candidate_count).toBe(5);
  });

  it("returns an empty page for no candidates", () => {
    const result = rankFeed([], { mode: "ranked", limit: 10, offset: 0, now: NOW });
    expect(result.entries).toEqual([]);
    expect(result.candidate_count).toBe(0);
    expect(result.has_more).toBe(false);
  });
});

describe("rankFeed — trending mode (#676)", () => {
  it("excludes posts outside the trending window", () => {
    const result = rankFeed(
      [
        post({ id: 1n, created_at: hoursAgo(24 * 30), like_count: 10_000n }),
        post({ id: 2n, created_at: hoursAgo(6), like_count: 3n }),
      ],
      { mode: "trending", limit: 10, offset: 0, now: NOW, trendingWindowDays: 7 }
    );

    // The stale viral post is outside the window and cannot appear, however
    // engaged it is.
    expect(result.entries.map((e) => e.id)).toEqual(["2"]);
  });

  it("favours a fresh post over a slightly-more-engaged older one", () => {
    const result = rankFeed(
      [
        post({ id: 1n, created_at: hoursAgo(72), like_count: 400n }),
        post({ id: 2n, created_at: hoursAgo(2), like_count: 100n }),
      ],
      { mode: "trending", limit: 10, offset: 0, now: NOW, trendingWindowDays: 7 }
    );
    expect(result.entries[0].id).toBe("2");
  });

  it("reports the trending window so the rule is explainable", () => {
    const result = rankFeed([post()], {
      mode: "trending",
      limit: 10,
      offset: 0,
      now: NOW,
      trendingWindowDays: 14,
    });
    expect(result.ranking.trending_window_days).toBe(14);
    expect(result.ranking.trending_gravity).toBeGreaterThan(0);
  });
});

describe("feed input validation", () => {
  it("defaults mode to ranked and rejects unknown modes", () => {
    expect(validateFeedMode(undefined)).toBe("ranked");
    expect(validateFeedMode("trending")).toBe("trending");
    expect(() => validateFeedMode("hot")).toThrow(FeedValidationError);
  });

  it("validates limit and offset", () => {
    expect(parseFeedLimit(undefined)).toBe(20);
    expect(parseFeedLimit("10")).toBe(10);
    expect(() => parseFeedLimit(0)).toThrow(FeedValidationError);
    expect(() => parseFeedLimit(101)).toThrow(FeedValidationError);
    expect(parseFeedOffset(undefined)).toBe(0);
    expect(() => parseFeedOffset(-1)).toThrow(FeedValidationError);
  });
});
