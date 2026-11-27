/**
 * Unit tests for the follow/unfollow event handlers.
 *
 * Issue #351 — acceptance criteria:
 *  - Happy path tested (Follow and Unfollow)
 *  - Idempotency tested
 *  - Database calls mocked with jest.mock
 */

import { handleFollow, handleUnfollow, isSelfFollow, FollowEvent, UnfollowEvent } from "../follow";
import { Database } from "../../db";

jest.mock("../../db");

function makeMockDb(): jest.Mocked<Database> {
  return {
    upsertProfile: jest.fn(),
    getFollow: jest.fn().mockResolvedValue(null),
    insertFollow: jest.fn().mockResolvedValue(undefined),
    deleteFollow: jest.fn().mockResolvedValue(undefined),
    insertPost: jest.fn(),
    markPostDeleted: jest.fn(),
    incrementPostLikeCount: jest.fn(),
    addPostTipTotal: jest.fn(),
    getPost: jest.fn(),
    upsertLike: jest.fn(),
    insertTip: jest.fn(),
    upsertPool: jest.fn(),
    adjustPoolBalance: jest.fn(),
    insertPool: jest.fn(),
    getPool: jest.fn(),
    listPools: jest.fn().mockResolvedValue({ pools: [], total: 0 }),
    addPoolAdmin: jest.fn(),
    removePoolAdmin: jest.fn(),
    getProfile: jest.fn(),
    listProfiles: jest.fn().mockResolvedValue({ profiles: [], total: 0 }),
    listPosts: jest.fn(),
    getFollowers: jest.fn(),
    getFollowing: jest.fn(),
    getFollowersAfter: jest.fn(),
    getFollowingAfter: jest.fn(),
    searchPosts: jest.fn().mockResolvedValue({ posts: [], total: 0 }),
    getTokenMetadata: jest.fn().mockResolvedValue(null),
  } as jest.Mocked<Database>;
}

// ── handleFollow ──────────────────────────────────────────────────────────────

describe("handleFollow", () => {
  let db: jest.Mocked<Database>;

  beforeEach(() => {
    db = makeMockDb();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("calls db.insertFollow with correct fields", async () => {
    const event: FollowEvent = {
      follower: "GABC123",
      followee: "GXYZ789",
      ledger: 100,
    };

    await handleFollow(db, event);

    expect(db.getFollow).toHaveBeenCalledWith("GABC123", "GXYZ789");
    expect(db.insertFollow).toHaveBeenCalledTimes(1);
    expect(db.insertFollow).toHaveBeenCalledWith({
      follower: "GABC123",
      followee: "GXYZ789",
      ledger: 100,
    });
  });

  it("resolves without error for a valid event", async () => {
    const event: FollowEvent = {
      follower: "GABC123",
      followee: "GXYZ789",
      ledger: 200,
    };

    await expect(handleFollow(db, event)).resolves.toBe("applied");
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  it("skips insert when the follow already exists", async () => {
    db.getFollow.mockResolvedValueOnce({
      follower: "GABC123",
      followee: "GXYZ789",
      ledger: 50,
    });

    const event: FollowEvent = {
      follower: "GABC123",
      followee: "GXYZ789",
      ledger: 100,
    };

    await handleFollow(db, event);

    expect(db.getFollow).toHaveBeenCalledWith("GABC123", "GXYZ789");
    expect(db.insertFollow).not.toHaveBeenCalled();
  });

  it("inserts when getFollow returns null", async () => {
    db.getFollow.mockResolvedValueOnce(null);

    const event: FollowEvent = {
      follower: "GABC123",
      followee: "GXYZ789",
      ledger: 100,
    };

    await handleFollow(db, event);

    expect(db.insertFollow).toHaveBeenCalledTimes(1);
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("throws when follower field is missing", async () => {
    const event = {
      follower: "",
      followee: "GXYZ789",
      ledger: 100,
    } as FollowEvent;

    await expect(handleFollow(db, event)).rejects.toThrow(
      "Follow event missing required field: follower"
    );
    expect(db.insertFollow).not.toHaveBeenCalled();
  });

  it("throws when followee field is missing", async () => {
    const event = {
      follower: "GABC123",
      followee: "",
      ledger: 100,
    } as FollowEvent;

    await expect(handleFollow(db, event)).rejects.toThrow(
      "Follow event missing required field: followee"
    );
    expect(db.insertFollow).not.toHaveBeenCalled();
  });

  // ── Database error propagation ──────────────────────────────────────────────

  it("propagates database errors", async () => {
    db.insertFollow.mockRejectedValueOnce(new Error("DB write failed"));

    const event: FollowEvent = {
      follower: "GABC123",
      followee: "GXYZ789",
      ledger: 100,
    };

    await expect(handleFollow(db, event)).rejects.toThrow("DB write failed");
  });
});

// ── handleUnfollow ────────────────────────────────────────────────────────────

describe("handleUnfollow", () => {
  let db: jest.Mocked<Database>;

  beforeEach(() => {
    db = makeMockDb();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("calls db.deleteFollow with correct follower and followee", async () => {
    db.getFollow.mockResolvedValueOnce({
      follower: "GABC123",
      followee: "GXYZ789",
      ledger: 100,
    });

    const event: UnfollowEvent = {
      follower: "GABC123",
      followee: "GXYZ789",
      ledger: 150,
    };

    await handleUnfollow(db, event);

    expect(db.getFollow).toHaveBeenCalledWith("GABC123", "GXYZ789");
    expect(db.deleteFollow).toHaveBeenCalledTimes(1);
    expect(db.deleteFollow).toHaveBeenCalledWith("GABC123", "GXYZ789");
  });

  it("resolves without error for a valid event", async () => {
    db.getFollow.mockResolvedValueOnce({
      follower: "GABC123",
      followee: "GXYZ789",
      ledger: 100,
    });

    const event: UnfollowEvent = {
      follower: "GABC123",
      followee: "GXYZ789",
      ledger: 150,
    };

    await expect(handleUnfollow(db, event)).resolves.toBe("applied");
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  it("skips delete when the follow does not exist", async () => {
    db.getFollow.mockResolvedValueOnce(null);

    const event: UnfollowEvent = {
      follower: "GABC123",
      followee: "GXYZ789",
      ledger: 150,
    };

    await handleUnfollow(db, event);

    expect(db.getFollow).toHaveBeenCalledWith("GABC123", "GXYZ789");
    expect(db.deleteFollow).not.toHaveBeenCalled();
  });

  it("deletes when getFollow returns a follow", async () => {
    db.getFollow.mockResolvedValueOnce({
      follower: "GABC123",
      followee: "GXYZ789",
      ledger: 100,
    });

    const event: UnfollowEvent = {
      follower: "GABC123",
      followee: "GXYZ789",
      ledger: 150,
    };

    await handleUnfollow(db, event);

    expect(db.deleteFollow).toHaveBeenCalledTimes(1);
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("throws when follower field is missing", async () => {
    const event = {
      follower: "",
      followee: "GXYZ789",
      ledger: 150,
    } as UnfollowEvent;

    await expect(handleUnfollow(db, event)).rejects.toThrow(
      "Unfollow event missing required field: follower"
    );
    expect(db.deleteFollow).not.toHaveBeenCalled();
  });

  it("throws when followee field is missing", async () => {
    const event = {
      follower: "GABC123",
      followee: "",
      ledger: 150,
    } as UnfollowEvent;

    await expect(handleUnfollow(db, event)).rejects.toThrow(
      "Unfollow event missing required field: followee"
    );
    expect(db.deleteFollow).not.toHaveBeenCalled();
  });

  // ── Database error propagation ──────────────────────────────────────────────

  it("propagates database errors", async () => {
    db.getFollow.mockResolvedValueOnce({
      follower: "GABC123",
      followee: "GXYZ789",
      ledger: 100,
    });
    db.deleteFollow.mockRejectedValueOnce(new Error("DB delete failed"));

    const event: UnfollowEvent = {
      follower: "GABC123",
      followee: "GXYZ789",
      ledger: 150,
    };

    await expect(handleUnfollow(db, event)).rejects.toThrow("DB delete failed");
  });
});

// ── Follow creation idempotency (issue #928) ─────────────────────────────────

describe("handleFollow — idempotency and replay safety (issue #928)", () => {
  function makeStatefulDb() {
    const relationships = new Set<string>();
    const key = (follower: string, followee: string): string => `${follower}:${followee}`;
// ── Repeated-unfollow semantics (issue #931) ─────────────────────────────────

describe("handleUnfollow — repeated deliveries (issue #931)", () => {
  /**
   * A stateful in-memory stand-in for the follows table: reads reflect writes,
   * so a replayed event sees the graph as it actually is rather than a canned
   * mock response. This is what lets the tests below assert on relationship
   * *counts* across several deliveries.
   */
  function makeStatefulDb(): {
    db: jest.Mocked<Database>;
    relationships: Set<string>;
  } {
    const relationships = new Set<string>();
    const key = (follower: string, followee: string): string => `${follower}:${followee}`;

    const db = {
      getFollow: jest.fn(async (follower: string, followee: string) =>
        relationships.has(key(follower, followee))
          ? { follower, followee, ledger: 100 }
          : null
      ),
      insertFollow: jest.fn(async (follow: { follower: string; followee: string }) => {
        relationships.add(key(follow.follower, follow.followee));
      }),
      deleteFollow: jest.fn(),
    } as unknown as jest.Mocked<Database>;
    return { db, relationships };
  }

  const FOLLOW: FollowEvent = { follower: "GABC123", followee: "GXYZ789", ledger: 100 };

  it("repeated follow deliveries do not create duplicate relationships", async () => {
    const { db, relationships } = makeStatefulDb();
    await handleFollow(db, FOLLOW);
    await handleFollow(db, FOLLOW);
    await handleFollow(db, FOLLOW);
    expect(relationships.size).toBe(1);
    expect(db.insertFollow).toHaveBeenCalledTimes(1);
  });

  it("follow replay leaves follower/following counts unchanged (no new rows)", async () => {
    const { db, relationships } = makeStatefulDb();
    await handleFollow(db, FOLLOW);
    const firstCount = relationships.size;
    await handleFollow(db, { ...FOLLOW, ledger: 120 });
    expect(relationships.size).toBe(firstCount);
    expect(db.insertFollow).toHaveBeenCalledTimes(1);
  });

  it("multiple different follows are recorded independently", async () => {
    const { db, relationships } = makeStatefulDb();
    await handleFollow(db, FOLLOW);
    await handleFollow(db, { follower: "GAAA", followee: "GBBB", ledger: 101 });
    await handleFollow(db, FOLLOW); // replay
    expect(relationships.size).toBe(2);
    expect(db.insertFollow).toHaveBeenCalledTimes(2);
      deleteFollow: jest.fn(async (follower: string, followee: string) => {
        relationships.delete(key(follower, followee));
      }),
    } as unknown as jest.Mocked<Database>;

    return { db, relationships };
  }

  const FOLLOW: FollowEvent = {
    follower: "GABC123",
    followee: "GXYZ789",
    ledger: 100,
  };
  const UNFOLLOW: UnfollowEvent = {
    follower: "GABC123",
    followee: "GXYZ789",
    ledger: 150,
  };

  it("deletes the relationship once, then replays are no-ops", async () => {
    const { db, relationships } = makeStatefulDb();

    await handleFollow(db, FOLLOW);
    expect(relationships.size).toBe(1);

    await handleUnfollow(db, UNFOLLOW);
    await handleUnfollow(db, UNFOLLOW);
    await handleUnfollow(db, UNFOLLOW);

    expect(relationships.size).toBe(0);
    expect(db.deleteFollow).toHaveBeenCalledTimes(1);
  });

  it("leaves relationship counts unchanged when the edge is already gone", async () => {
    const { db, relationships } = makeStatefulDb();

    await handleUnfollow(db, UNFOLLOW);
    await handleUnfollow(db, UNFOLLOW);

    expect(db.deleteFollow).not.toHaveBeenCalled();
    expect(relationships.size).toBe(0);
  });

  it("does not touch unrelated relationships in the graph", async () => {
    const { db, relationships } = makeStatefulDb();

    await handleFollow(db, FOLLOW);
    await handleFollow(db, { follower: "GOTHER1", followee: "GOTHER2", ledger: 101 });
    expect(relationships.size).toBe(2);

    await handleUnfollow(db, UNFOLLOW);
    await handleUnfollow(db, UNFOLLOW);

    expect(relationships.size).toBe(1);
    expect(relationships.has("GOTHER1:GOTHER2")).toBe(true);
    expect(relationships.has("GABC123:GXYZ789")).toBe(false);
  });

  it("converges on the same count for an interleaved replay sequence", async () => {
    const { db, relationships } = makeStatefulDb();

    await handleFollow(db, FOLLOW);
    await handleUnfollow(db, UNFOLLOW);
    await handleFollow(db, FOLLOW);
    await handleUnfollow(db, UNFOLLOW);
    await handleUnfollow(db, UNFOLLOW);
    expect(relationships.size).toBe(0);

    await handleFollow(db, FOLLOW);
    expect(relationships.size).toBe(1);
  });

  it("rejects a malformed replayed unfollow without writing", async () => {
    const { db, relationships } = makeStatefulDb();

    await expect(
      handleUnfollow(db, { ...UNFOLLOW, follower: "" })
    ).rejects.toThrow("Unfollow event missing required field: follower");

    expect(db.deleteFollow).not.toHaveBeenCalled();
    expect(relationships.size).toBe(0);
  });
});

/**
 * Self-follow rejection (BE-13).
 *
 * The rule is enforced in the write path with no database call, so a rejected
 * event cannot leave any state behind.
 */
describe("handleFollow � self-follow (BE-13)", () => {
  let db: jest.Mocked<Database>;

  const ADDRESS = `G${"A".repeat(55)}`;
  const OTHER = `G${"B".repeat(55)}`;

  beforeEach(() => {
    db = makeMockDb();
  });

  it("rejects an exact self-follow and touches no database state", async () => {
    await expect(
      handleFollow(db, { follower: ADDRESS, followee: ADDRESS, ledger: 5 })
    ).rejects.toThrow(/cannot follow itself/);

    expect(db.getFollow).not.toHaveBeenCalled();
    expect(db.insertFollow).not.toHaveBeenCalled();
    expect(db.deleteFollow).not.toHaveBeenCalled();
  });

  it("rejects a self-follow that differs only in casing", async () => {
    await expect(
      handleFollow(db, {
        follower: ADDRESS,
        followee: ADDRESS.toLowerCase(),
        ledger: 5,
      })
    ).rejects.toThrow(/cannot follow itself/);

    expect(db.insertFollow).not.toHaveBeenCalled();
  });

  it("identifies a self-follow regardless of whitespace", () => {
    expect(isSelfFollow(ADDRESS, ADDRESS)).toBe(true);
    expect(isSelfFollow(ADDRESS, ` ${ADDRESS.toLowerCase()} `)).toBe(true);
    expect(isSelfFollow(ADDRESS, OTHER)).toBe(false);
  });

  it("does not treat a structurally invalid address as a self-follow", () => {
    // Validity is the per-field check's job; claiming "self-follow" here would
    // report the wrong reason for the rejection.
    expect(isSelfFollow("not-an-address", "not-an-address")).toBe(false);
  });

  it("still follows a different account", async () => {
    await handleFollow(db, { follower: ADDRESS, followee: OTHER, ledger: 5 });
    expect(db.insertFollow).toHaveBeenCalledWith({
      follower: ADDRESS,
      followee: OTHER,
      ledger: 5,
    });
  });
});

describe("follow/unfollow outcomes and stored relationship (BE-026)", () => {
  /** Stateful fake: the stored edge set the handlers act on. */
  function statefulDb() {
    const edges = new Map<string, { follower: string; followee: string; ledger: number }>();
    const key = (a: string, b: string) => `${a}>${b}`;
    const db = {
      getFollow: jest.fn(async (a: string, b: string) => edges.get(key(a, b)) ?? null),
      insertFollow: jest.fn(async (f: { follower: string; followee: string; ledger: number }) => {
        edges.set(key(f.follower, f.followee), f);
      }),
      deleteFollow: jest.fn(async (a: string, b: string) => void edges.delete(key(a, b))),
    } as unknown as jest.Mocked<Database>;
    return { db, edges };
  }

  const follow: FollowEvent = { follower: "GABC123", followee: "GXYZ789", ledger: 10 };
  const unfollow: UnfollowEvent = { follower: "GABC123", followee: "GXYZ789", ledger: 11 };

  it("reports applied once, then noop for repeated follows, with one stored edge", async () => {
    const { db, edges } = statefulDb();
    expect(await handleFollow(db, follow)).toBe("applied");
    expect(await handleFollow(db, follow)).toBe("noop");
    expect(await handleFollow(db, { ...follow, ledger: 99 })).toBe("noop");
    expect(db.insertFollow).toHaveBeenCalledTimes(1);
    expect(edges.size).toBe(1);
    expect(edges.get("GABC123>GXYZ789")?.ledger).toBe(10); // first write wins
  });

  it("reports applied once, then noop for repeated unfollows, leaving no edge", async () => {
    const { db, edges } = statefulDb();
    await handleFollow(db, follow);
    expect(await handleUnfollow(db, unfollow)).toBe("applied");
    expect(await handleUnfollow(db, unfollow)).toBe("noop");
    expect(db.deleteFollow).toHaveBeenCalledTimes(1);
    expect(edges.size).toBe(0);
  });

  it("an unfollow of a never-followed account is a noop that writes nothing", async () => {
    const { db } = statefulDb();
    expect(await handleUnfollow(db, unfollow)).toBe("noop");
    expect(db.deleteFollow).not.toHaveBeenCalled();
  });

  it("follow, unfollow, follow ends with exactly one edge", async () => {
    const { db, edges } = statefulDb();
    await handleFollow(db, follow);
    await handleUnfollow(db, unfollow);
    expect(await handleFollow(db, { ...follow, ledger: 12 })).toBe("applied");
    expect(edges.size).toBe(1);
  });

  it("treats a unique-violation from a racing insert as a noop", async () => {
    const { db } = statefulDb();
    (db.insertFollow as jest.Mock).mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    expect(await handleFollow(db, follow)).toBe("noop");
  });

  it("still throws other insert errors", async () => {
    const { db } = statefulDb();
    (db.insertFollow as jest.Mock).mockRejectedValueOnce(new Error("connection lost"));
    await expect(handleFollow(db, follow)).rejects.toThrow("connection lost");
  });
});
