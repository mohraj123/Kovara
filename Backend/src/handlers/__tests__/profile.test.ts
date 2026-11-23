/**
 * Unit tests for the profile event handler.
 *
 * Issue #351 — acceptance criteria:
 *  - Happy path tested
 *  - Idempotency tested
 *  - Database calls mocked with jest.mock
 */

import {
  handleProfileSet,
  ProfileSetEvent,
  MAX_USERNAME_LENGTH,
  MAX_CREATOR_TOKEN_LENGTH,
} from "../profile";
import { Database } from "../../db";

// Mock the entire db module so no real database is needed.
jest.mock("../../db");

function makeMockDb(): jest.Mocked<Database> {
  return {
    upsertProfile: jest.fn().mockResolvedValue(undefined),
    getFollow: jest.fn(),
    insertFollow: jest.fn(),
    deleteFollow: jest.fn(),
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

describe("handleProfileSet", () => {
  let db: jest.Mocked<Database>;

  beforeEach(() => {
    db = makeMockDb();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("calls db.upsertProfile with the correct fields", async () => {
    const event: ProfileSetEvent = {
      user: "GABC123",
      username: "alice",
      creator_token: "GTOKEN456",
      ledger: 1000,
    };

    await handleProfileSet(db, event);

    expect(db.upsertProfile).toHaveBeenCalledTimes(1);
    expect(db.upsertProfile).toHaveBeenCalledWith({
      address: "GABC123",
      username: "alice",
      creator_token: "GTOKEN456",
      updated_ledger: 1000,
    });
  });

  it("resolves without error for a valid event", async () => {
    const event: ProfileSetEvent = {
      user: "GABC123",
      username: "bob",
      creator_token: "GTOKEN789",
      ledger: 2000,
    };

    await expect(handleProfileSet(db, event)).resolves.toBeUndefined();
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  it("is idempotent — calling twice with the same event calls upsertProfile twice", async () => {
    const event: ProfileSetEvent = {
      user: "GABC123",
      username: "alice",
      creator_token: "GTOKEN456",
      ledger: 1000,
    };

    await handleProfileSet(db, event);
    await handleProfileSet(db, event);

    // Both calls must reach the database; the db layer handles upsert semantics.
    expect(db.upsertProfile).toHaveBeenCalledTimes(2);
    expect(db.upsertProfile).toHaveBeenNthCalledWith(1, {
      address: "GABC123",
      username: "alice",
      creator_token: "GTOKEN456",
      updated_ledger: 1000,
    });
    expect(db.upsertProfile).toHaveBeenNthCalledWith(2, {
      address: "GABC123",
      username: "alice",
      creator_token: "GTOKEN456",
      updated_ledger: 1000,
    });
  });

  it("upserts with updated username when the same user changes their name", async () => {
    const first: ProfileSetEvent = {
      user: "GABC123",
      username: "alice",
      creator_token: "GTOKEN456",
      ledger: 1000,
    };
    const second: ProfileSetEvent = {
      user: "GABC123",
      username: "alice_v2",
      creator_token: "GTOKEN456",
      ledger: 1500,
    };

    await handleProfileSet(db, first);
    await handleProfileSet(db, second);

    expect(db.upsertProfile).toHaveBeenCalledTimes(2);
    expect(db.upsertProfile).toHaveBeenLastCalledWith({
      address: "GABC123",
      username: "alice_v2",
      creator_token: "GTOKEN456",
      updated_ledger: 1500,
    });
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("throws when user field is missing", async () => {
    const event = {
      user: "",
      username: "alice",
      creator_token: "GTOKEN456",
      ledger: 1000,
    } as ProfileSetEvent;

    await expect(handleProfileSet(db, event)).rejects.toThrow(
      "ProfileSet event missing required field: user"
    );
    expect(db.upsertProfile).not.toHaveBeenCalled();
  });

  it("throws when username field is missing", async () => {
    const event = {
      user: "GABC123",
      username: "",
      creator_token: "GTOKEN456",
      ledger: 1000,
    } as ProfileSetEvent;

    await expect(handleProfileSet(db, event)).rejects.toThrow(
      "ProfileSet event missing required field: username"
    );
    expect(db.upsertProfile).not.toHaveBeenCalled();
  });

  // ── Database error propagation ──────────────────────────────────────────────

  it("propagates database errors", async () => {
    db.upsertProfile.mockRejectedValueOnce(new Error("DB connection lost"));

    const event: ProfileSetEvent = {
      user: "GABC123",
      username: "alice",
      creator_token: "GTOKEN456",
      ledger: 1000,
    };

    await expect(handleProfileSet(db, event)).rejects.toThrow("DB connection lost");
  });
});

// ── Stale event protection (issue #927) ──────────────────────────────────────

describe("handleProfileSet — stale event protection (issue #927)", () => {
  function makeDb(existing?: { address: string; username: string; creator_token: string; updated_ledger: number }) {
    return {
      getProfile: jest.fn().mockResolvedValue(existing ?? null),
      upsertProfile: jest.fn().mockResolvedValue(undefined),
      getFollow: jest.fn(),
      insertFollow: jest.fn(),
      deleteFollow: jest.fn(),
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

  it("applies event when no existing profile exists", async () => {
    const db = makeDb(undefined);
    await handleProfileSet(db, { user: "GA", username: "alice", creator_token: "T", ledger: 100 });
    expect(db.upsertProfile).toHaveBeenCalledTimes(1);
    expect(db.upsertProfile).toHaveBeenCalledWith(
      expect.objectContaining({ address: "GA", updated_ledger: 100 })
    );
  });

  it("ignores event with lower ledger than stored (out of order)", async () => {
    const db = makeDb({ address: "GA", username: "alice", creator_token: "T", updated_ledger: 200 });
    await handleProfileSet(db, { user: "GA", username: "alice_old", creator_token: "T2", ledger: 150 });
    expect(db.upsertProfile).not.toHaveBeenCalled();
  });

  it("ignores event with equal ledger as stored (stale/replay)", async () => {
    const db = makeDb({ address: "GA", username: "alice", creator_token: "T", updated_ledger: 200 });
    await handleProfileSet(db, { user: "GA", username: "alice_dup", creator_token: "T", ledger: 200 });
    expect(db.upsertProfile).not.toHaveBeenCalled();
  });

  it("applies event with higher ledger than stored", async () => {
    const db = makeDb({ address: "GA", username: "alice", creator_token: "T", updated_ledger: 200 });
    await handleProfileSet(db, { user: "GA", username: "alice_new", creator_token: "T3", ledger: 250 });
    expect(db.upsertProfile).toHaveBeenCalledTimes(1);
    expect(db.upsertProfile).toHaveBeenCalledWith(
      expect.objectContaining({ username: "alice_new", updated_ledger: 250 })
    );
  });

  it("repeated out-of-order deliveries do not mutate profile", async () => {
    const db = makeDb({ address: "GA", username: "alice", creator_token: "T", updated_ledger: 500 });
    for (let i = 0; i < 3; i++) {
      await handleProfileSet(db, { user: "GA", username: "stale", creator_token: "X", ledger: 400 });
    }
    expect(db.upsertProfile).not.toHaveBeenCalled();
  });
});

/**
 * Replay safety (BE-07).
 *
 * `ProfileSet` states a desired end state, so applying N deliveries must leave
 * exactly the profile that applying one delivery would. The ledger comparison
 * covers both halves of "replay": a redelivery of the event already applied
 * (`ledger ===`), and a replayed older one (`ledger <`).
 */
describe("handleProfileSet � replay safety (BE-07)", () => {
  function makeDb(existing?: {
    address: string;
    username: string;
    creator_token: string;
    updated_ledger: number;
  }) {
    return {
      getProfile: jest.fn().mockResolvedValue(existing ?? null),
      upsertProfile: jest.fn().mockResolvedValue(undefined),
      getFollow: jest.fn(),
      insertFollow: jest.fn(),
      deleteFollow: jest.fn(),
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

  const stored = {
    address: "GA",
    username: "alice",
    creator_token: "T",
    updated_ledger: 100,
  };

  it("ignores a redelivery of the event already applied", async () => {
    const db = makeDb({ ...stored });

    await handleProfileSet(db, {
      user: "GA",
      username: "alice",
      creator_token: "T",
      ledger: 100,
    });

    expect(db.upsertProfile).not.toHaveBeenCalled();
  });

  it("ignores a replayed older event carrying a different username", async () => {
    const db = makeDb({ ...stored });

    await handleProfileSet(db, {
      user: "GA",
      username: "impostor",
      creator_token: "X",
      ledger: 99,
    });

    expect(db.upsertProfile).not.toHaveBeenCalled();
  });

  it("writes nothing for a burst that contains no event newer than the stored one", async () => {
    const db = makeDb({ ...stored });

    for (const ledger of [98, 97, 100]) {
      await handleProfileSet(db, {
        user: "GA",
        username: `name-${ledger}`,
        creator_token: "T",
        ledger,
      });
    }

    // Stored ledger is 100, so nothing in this burst may write — not even the
    // event that ties it.
    expect(db.upsertProfile).not.toHaveBeenCalled();
  });

  it("applies an event that is strictly newer than the stored ledger", async () => {
    const db = makeDb({ ...stored });

    await handleProfileSet(db, {
      user: "GA",
      username: "alice2",
      creator_token: "T",
      ledger: 101,
    });

    expect(db.upsertProfile).toHaveBeenCalledTimes(1);
    expect(db.upsertProfile).toHaveBeenCalledWith(
      expect.objectContaining({ username: "alice2", updated_ledger: 101 })
    );
  });

  it("matches the stored row even when the event carries a different casing", async () => {
    // A replayed event must not miss the row and open a second profile.
    const db = makeDb({ ...stored, address: "GA" });

    await handleProfileSet(db, {
      user: "ga",
      username: "alice",
      creator_token: "T",
      ledger: 100,
    });

    expect(db.getProfile).toHaveBeenCalledWith("GA");
    expect(db.upsertProfile).not.toHaveBeenCalled();
  });
});

describe("handleProfileSet — length limits and partial updates (BE-030)", () => {
  const stored = { address: "GABC123", username: "alice", creator_token: "TOKEN-OLD", updated_ledger: 100 };
  const makeDb = (existing?: typeof stored) =>
    ({
      getProfile: jest.fn().mockResolvedValue(existing ?? null),
      upsertProfile: jest.fn().mockResolvedValue(undefined),
    }) as unknown as jest.Mocked<Database>;

  it("accepts a username and token exactly at the limits", async () => {
    const db = makeDb();
    await handleProfileSet(db, {
      user: "gabc123",
      username: "u".repeat(MAX_USERNAME_LENGTH),
      creator_token: "t".repeat(MAX_CREATOR_TOKEN_LENGTH),
      ledger: 1,
    });
    expect(db.upsertProfile).toHaveBeenCalledTimes(1);
  });

  it("rejects a username one character over the limit before any database call", async () => {
    const db = makeDb();
    await expect(
      handleProfileSet(db, { user: "GABC123", username: "u".repeat(MAX_USERNAME_LENGTH + 1), ledger: 1 })
    ).rejects.toThrow(`username exceeds ${MAX_USERNAME_LENGTH}`);
    expect(db.getProfile).not.toHaveBeenCalled();
    expect(db.upsertProfile).not.toHaveBeenCalled();
  });

  it("rejects a creator_token over the limit", async () => {
    const db = makeDb();
    await expect(
      handleProfileSet(db, {
        user: "GABC123",
        username: "alice",
        creator_token: "t".repeat(MAX_CREATOR_TOKEN_LENGTH + 1),
        ledger: 1,
      })
    ).rejects.toThrow(`creator_token exceeds ${MAX_CREATOR_TOKEN_LENGTH}`);
    expect(db.upsertProfile).not.toHaveBeenCalled();
  });

  it("measures length after trimming", async () => {
    const db = makeDb();
    await handleProfileSet(db, {
      user: "GABC123",
      username: `  ${"u".repeat(MAX_USERNAME_LENGTH)}  `,
      ledger: 1,
    });
    expect(db.upsertProfile).toHaveBeenCalledWith(
      expect.objectContaining({ username: "u".repeat(MAX_USERNAME_LENGTH) })
    );
  });

  it("keeps the stored creator_token when the field is omitted", async () => {
    const db = makeDb(stored);
    await handleProfileSet(db, { user: "GABC123", username: "alice2", ledger: 101 });
    expect(db.upsertProfile).toHaveBeenCalledWith({
      address: "GABC123",
      username: "alice2",
      creator_token: "TOKEN-OLD",
      updated_ledger: 101,
    });
  });

  it("clears the creator_token when it is explicitly empty", async () => {
    const db = makeDb(stored);
    await handleProfileSet(db, { user: "GABC123", username: "alice", creator_token: "", ledger: 101 });
    expect(db.upsertProfile).toHaveBeenCalledWith(expect.objectContaining({ creator_token: "" }));
  });

  it("keeps the stored username when it is omitted on an update", async () => {
    const db = makeDb(stored);
    await handleProfileSet(db, { user: "GABC123", creator_token: "TOKEN-NEW", ledger: 101 });
    expect(db.upsertProfile).toHaveBeenCalledWith(
      expect.objectContaining({ username: "alice", creator_token: "TOKEN-NEW" })
    );
  });

  it("rejects an explicitly empty username", async () => {
    const db = makeDb(stored);
    await expect(handleProfileSet(db, { user: "GABC123", username: "", ledger: 101 })).rejects.toThrow(
      "missing required field: username"
    );
    await expect(handleProfileSet(db, { user: "GABC123", username: "   ", ledger: 101 })).rejects.toThrow(
      "non-empty after trimming"
    );
  });

  it("requires a username when there is no stored profile to keep", async () => {
    const db = makeDb();
    await expect(handleProfileSet(db, { user: "GABC123", creator_token: "T", ledger: 1 })).rejects.toThrow(
      "missing required field: username"
    );
    expect(db.upsertProfile).not.toHaveBeenCalled();
  });
});
