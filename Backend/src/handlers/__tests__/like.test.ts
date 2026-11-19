/**
 * Unit tests for like event handler
 */

import { Pool } from "pg";
import { handleLike, handleUnlike, createMockLikeEvent } from "../like";

// Mock pg Pool and Client
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockClient = {
  query: mockQuery,
  release: mockRelease,
};
const mockConnect = jest.fn().mockResolvedValue(mockClient);
const mockPool = {
  connect: mockConnect,
} as unknown as Pool;

describe("Like Event Handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should insert like and increment post like_count", async () => {
    const { event, context } = createMockLikeEvent("GUSER123", 1n);

    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1 }] }); // Post exists check
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // INSERT like
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE post
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // COMMIT

    await handleLike(mockPool, event, context);

    expect(mockQuery).toHaveBeenCalledWith("BEGIN");
    expect(mockQuery).toHaveBeenCalledWith(
      "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, deleted_at FROM posts"),
      expect.arrayContaining(["1"])
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO likes"),
      expect.arrayContaining(["1", "GUSER123", context.timestamp, context.txHash])
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE posts"),
      expect.arrayContaining(["1"])
    );
    expect(mockQuery).toHaveBeenCalledWith("COMMIT");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("should be idempotent (skip duplicate like)", async () => {
    const { event, context } = createMockLikeEvent("GUSER123", 1n);

    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1 }] }); // Post exists check
    mockQuery.mockResolvedValueOnce({ rowCount: 0 }); // INSERT like (conflict)
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // COMMIT

    await handleLike(mockPool, event, context);

    expect(mockQuery).toHaveBeenCalledWith("BEGIN");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (post_id, user_address) DO NOTHING"),
      expect.any(Array)
    );
    expect(mockQuery).toHaveBeenCalledWith("COMMIT");
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("UPDATE posts"),
      expect.any(Array)
    );
  });

  it("should rollback on error", async () => {
    const { event, context } = createMockLikeEvent("GUSER123", 1n);

    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1 }] }); // Post exists check
    mockQuery.mockRejectedValueOnce(new Error("DB error")); // INSERT fails
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // ROLLBACK

    await expect(handleLike(mockPool, event, context)).rejects.toThrow("DB error");

    expect(mockQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("should skip like when post does not exist", async () => {
    const { event, context } = createMockLikeEvent();

    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // Post not found
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // COMMIT

    await handleLike(mockPool, event, context);

    expect(mockQuery).toHaveBeenCalledWith("COMMIT");
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO likes"),
      expect.any(Array)
    );
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("UPDATE posts"),
      expect.any(Array)
    );
    expect(mockRelease).toHaveBeenCalled();
  });

  it("should reject a like on a deleted post without creating a like row", async () => {
    const { event, context } = createMockLikeEvent("GUSER123", 1n);

    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 1, deleted_at: new Date("2026-01-01T00:00:00Z") }],
    }); // Post exists but is soft-deleted
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // COMMIT

    await handleLike(mockPool, event, context);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, deleted_at FROM posts"),
      expect.arrayContaining(["1"])
    );
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO likes"),
      expect.any(Array)
    );
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("UPDATE posts"),
      expect.any(Array)
    );
    expect(mockQuery).toHaveBeenCalledWith("COMMIT");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("should reject a like on a missing post without creating a like row", async () => {
    const { event, context } = createMockLikeEvent("GUSER123", 99n);

    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // Post not found
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // COMMIT

    await handleLike(mockPool, event, context);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, deleted_at FROM posts"),
      expect.arrayContaining(["99"])
    );
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO likes"),
      expect.any(Array)
    );
    expect(mockQuery).toHaveBeenCalledWith("COMMIT");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("should recompute like_count from the likes table instead of incrementing it", async () => {
    const { event, context } = createMockLikeEvent("GUSER123", 1n);

    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1, deleted_at: null }] }); // Post exists
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1 }] }); // INSERT like
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE post (recount)
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // COMMIT

    await handleLike(mockPool, event, context);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET like_count = (SELECT COUNT(*) FROM likes WHERE post_id = $1)"),
      expect.arrayContaining(["1"])
    );
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("like_count = like_count + 1"),
      expect.any(Array)
    );
  });

  it("should not move like_count when a redelivered like hits the unique constraint", async () => {
    const { event, context } = createMockLikeEvent("GUSER123", 1n);

    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1, deleted_at: null }] }); // Post exists
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // INSERT like (conflict)
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // COMMIT

    await handleLike(mockPool, event, context);

    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("UPDATE posts"),
      expect.any(Array)
    );
  });

  it("keeps like_count equal to the number of like rows across repeated deliveries", async () => {
    const likeRows = new Set<string>();
    const post = { id: "1", deleted_at: null as Date | null, like_count: 0 };

    mockQuery.mockImplementation(async (text: string, values?: unknown[]) => {
      const sql = text.replace(/\s+/g, " ").trim().toLowerCase();

      if (sql === "begin" || sql.startsWith("set transaction")) return { rowCount: 1 };
      if (sql === "commit" || sql === "rollback") return { rowCount: 1 };

      if (sql.startsWith("select id, deleted_at from posts")) {
        if (post.deleted_at !== null) return { rowCount: 1, rows: [{ id: 1, deleted_at: post.deleted_at }] };
        return { rowCount: 1, rows: [{ id: 1, deleted_at: null }] };
      }

      if (sql.startsWith("insert into likes")) {
        const user = String(values?.[1]);
        if (likeRows.has(user)) return { rowCount: 0, rows: [] };
        likeRows.add(user);
        return { rowCount: 1, rows: [{ id: likeRows.size }] };
      }

      if (sql.startsWith("update posts")) {
        post.like_count = likeRows.size;
        return { rowCount: 1 };
      }

      throw new Error(`unexpected query in test: ${text}`);
    });

    const { event, context } = createMockLikeEvent("GUSER123", 1n);

    await handleLike(mockPool, event, context); // first delivery
    await handleLike(mockPool, event, context); // replay
    await handleLike(mockPool, event, context); // replay

    expect(likeRows.size).toBe(1);
    expect(post.like_count).toBe(1);
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("like_count = like_count + 1"),
      expect.any(Array)
    );
  });

  it("should retry on serialization failure", async () => {
    const { event, context } = createMockLikeEvent("GUSER123", 1n);

    const serErr = new Error("could not serialize access");
    (serErr as any).code = "40001";

    // First attempt
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1 }] }); // Post exists check
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // INSERT like
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE post
    mockQuery.mockRejectedValueOnce(serErr); // COMMIT fails with serialization error
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // ROLLBACK

    // Second attempt
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1 }] }); // Post exists check
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // INSERT like (idempotent)
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE post
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // COMMIT

    await handleLike(mockPool, event, context);

    expect(mockConnect).toHaveBeenCalledTimes(2);
  });
});

/**
 * A small in-memory stand-in for the posts and likes tables. Every query yields
 * to the event loop first, so handlers started together genuinely interleave.
 */
function fakeLikesPool(postId = "1") {
  const likes = new Set<string>(); // `${post}:${user}`
  const post = { like_count: 0, deleted_at: null as Date | null };
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const count = () => [...likes].filter((k) => k.startsWith(`${postId}:`)).length;

  const client = {
    release: jest.fn(),
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      await tick();
      const text = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(text)) return { rowCount: 0, rows: [] };
      if (text.startsWith("SELECT id, deleted_at FROM posts")) {
        return { rowCount: 1, rows: [{ id: postId, deleted_at: post.deleted_at }] };
      }
      if (text.startsWith("INSERT INTO likes")) {
        const key = `${params[0]}:${params[1]}`;
        if (likes.has(key)) return { rowCount: 0, rows: [] };
        likes.add(key);
        return { rowCount: 1, rows: [{ id: likes.size }] };
      }
      if (text.startsWith("DELETE FROM likes")) {
        const key = `${params[0]}:${params[1]}`;
        return likes.delete(key) ? { rowCount: 1, rows: [{ id: 1 }] } : { rowCount: 0, rows: [] };
      }
      if (text.startsWith("UPDATE posts")) {
        post.like_count = count();
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    }),
  };
  const pool = { connect: jest.fn(async () => client) } as unknown as Pool;
  return { pool, post, likes, count };
}

describe("like count consistency under concurrency (BE-027)", () => {
  it("duplicate concurrent like events leave one row and a count of 1", async () => {
    const { pool, post, count } = fakeLikesPool();
    const { event, context } = createMockLikeEvent("GUSER1", 1n);
    await Promise.all([handleLike(pool, event, context), handleLike(pool, event, context), handleLike(pool, event, context)]);
    expect(count()).toBe(1);
    expect(post.like_count).toBe(1);
  });

  it("concurrent likes from different users are all counted", async () => {
    const { pool, post, count } = fakeLikesPool();
    await Promise.all(
      ["GA", "GB", "GC", "GD"].map((u) => {
        const { event, context } = createMockLikeEvent(u, 1n);
        return handleLike(pool, event, context);
      })
    );
    expect(count()).toBe(4);
    expect(post.like_count).toBe(4);
  });

  it("an unlike after a like returns the count to zero, and a repeat unlike is a no-op", async () => {
    const { pool, post, count } = fakeLikesPool();
    const { event, context } = createMockLikeEvent("GUSER1", 1n);
    await handleLike(pool, event, context);
    await handleUnlike(pool, { user: "GUSER1", post_id: 1n });
    await handleUnlike(pool, { user: "GUSER1", post_id: 1n });
    expect(count()).toBe(0);
    expect(post.like_count).toBe(0);
  });

  it("opposing like/unlike events converge on the like rows, whatever the interleaving", async () => {
    const { pool, post, count } = fakeLikesPool();
    const a = createMockLikeEvent("GA", 1n);
    const b = createMockLikeEvent("GB", 1n);
    await handleLike(pool, a.event, a.context);
    await Promise.all([
      handleUnlike(pool, { user: "GA", post_id: 1n }),
      handleLike(pool, b.event, b.context),
      handleLike(pool, a.event, a.context),
      handleUnlike(pool, { user: "GB", post_id: 1n }),
    ]);
    expect(post.like_count).toBe(count());
  });

  it("an unlike with no like row issues no count update", async () => {
    const { pool } = fakeLikesPool();
    await handleUnlike(pool, { user: "GNOBODY", post_id: 1n });
    const calls = (await pool.connect() as unknown as { query: jest.Mock }).query.mock.calls.map((c) => String(c[0]));
    expect(calls.some((q) => q.trim().startsWith("UPDATE posts"))).toBe(false);
  });
});
