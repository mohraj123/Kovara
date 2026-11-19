import {
  DEFAULT_FEED_WEIGHTS,
  FeedCandidate,
  FeedValidationError,
  engagementScore,
  parseFeedLimit,
  parseFeedOffset,
  parseTrendingWindowDays,
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

/**
 * Tied timestamps (BE-05).
 *
 * `recent` mode scores a post by its age, so two posts written in the same
 * ledger second score identically. Without a total order the database is free
 * to return those rows in any order, and a client paging with `offset` then
 * sees one row twice and never sees the other. The `id_desc` tie-break makes
 * the order independent of how the rows came back.
 */
describe("rankFeed — tied timestamps (BE-05)", () => {
  const tied = [
    post({ id: 7n, created_at: hoursAgo(3), like_count: 12n }),
    post({ id: 3n, created_at: hoursAgo(3), like_count: 12n }),
    post({ id: 11n, created_at: hoursAgo(3), like_count: 12n }),
  ];

  it("breaks a tied recent-mode timestamp by id descending", () => {
    const result = rankFeed(tied, { mode: "recent", limit: 10, offset: 0, now: NOW });
    expect(result.entries.map((e) => e.id)).toEqual(["11", "7", "3"]);
  });

  it("returns the same order whichever way the tied rows arrive", () => {
    const orders = [
      [tied[0], tied[1], tied[2]],
      [tied[2], tied[1], tied[0]],
      [tied[1], tied[2], tied[0]],
    ];

    for (const order of orders) {
      const result = rankFeed(order, { mode: "recent", limit: 10, offset: 0, now: NOW });
      expect(result.entries.map((e) => e.id)).toEqual(["11", "7", "3"]);
    }
  });

  it("keeps the tie-break in ranked mode when scores match exactly", () => {
    const result = rankFeed(tied, { mode: "ranked", limit: 10, offset: 0, now: NOW });
    expect(result.entries.map((e) => e.id)).toEqual(["11", "7", "3"]);
  });

  it("does not repeat or skip a tied post across pages", () => {
    const page1 = rankFeed(tied, { mode: "recent", limit: 2, offset: 0, now: NOW });
    const page2 = rankFeed(tied, { mode: "recent", limit: 2, offset: 2, now: NOW });

    const seen = [...page1.entries, ...page2.entries].map((e) => e.id);
    expect(seen).toEqual(["11", "7", "3"]);
    expect(new Set(seen).size).toBe(3);
    expect(page1.has_more).toBe(true);
    expect(page2.has_more).toBe(false);
  });

  it("sorts posts with no timestamp last, still tied by id descending", () => {
    const result = rankFeed(
      [
        post({ id: 5n, created_at: null }),
        post({ id: 9n, created_at: null }),
        post({ id: 2n, created_at: hoursAgo(1) }),
      ],
      { mode: "recent", limit: 10, offset: 0, now: NOW }
    );
    expect(result.entries.map((e) => e.id)).toEqual(["2", "9", "5"]);
  });

  it("reports the tie policy in the echoed ruleset", () => {
    const result = rankFeed(tied, { mode: "recent", limit: 10, offset: 0, now: NOW });
    expect(result.ranking.tie_break).toBe("id_desc");
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

  it("validates the trending window and exposes it in the ruleset", () => {
    expect(parseTrendingWindowDays(undefined)).toBe(7);
    expect(parseTrendingWindowDays("14")).toBe(14);
    expect(() => parseTrendingWindowDays("0")).toThrow(FeedValidationError);
    expect(() => parseTrendingWindowDays("366")).toThrow(FeedValidationError);
  });
});
