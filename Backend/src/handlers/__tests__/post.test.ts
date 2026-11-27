/**
 * Unit tests for post event handlers
 */

import { Pool } from "pg";
import {
  handlePostCreated,
  handlePostDeleted,
  validatePostId,
  MAX_POST_ID,
  createMockPostCreatedEvent,
  createMockPostDeletedEvent,
} from "../post";

// Mock pg Pool
const mockQuery = jest.fn();
const mockPool = {
  query: mockQuery,
} as unknown as Pool;

describe("Post Event Handlers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("handlePostCreated", () => {
    it("should insert a new post", async () => {
      const { event, context } = createMockPostCreatedEvent(1n, "GTEST123");
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await handlePostCreated(mockPool, event, context);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO posts"),
        expect.arrayContaining(["1", "GTEST123", "Test post content", 0, 0, context.timestamp])
      );
    });

    it("should be idempotent (skip duplicate)", async () => {
      const { event, context } = createMockPostCreatedEvent(1n, "GTEST123");
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      await handlePostCreated(mockPool, event, context);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("ON CONFLICT (id) DO NOTHING"),
        expect.any(Array)
      );
    });

    it("should handle errors gracefully", async () => {
      const { event, context } = createMockPostCreatedEvent();
      mockQuery.mockRejectedValueOnce(new Error("DB error"));

      await expect(handlePostCreated(mockPool, event, context)).rejects.toThrow("DB error");
    });
  });

  describe("handlePostDeleted", () => {
    it("should soft delete a post", async () => {
      const { event, context } = createMockPostDeletedEvent(1n, "GTEST123");
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await handlePostDeleted(mockPool, event, context);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE posts"),
        expect.arrayContaining([context.timestamp, "1", "GTEST123"])
      );
    });

    it("should be idempotent (skip already deleted)", async () => {
      const { event, context } = createMockPostDeletedEvent(1n, "GTEST123");
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });

      await handlePostDeleted(mockPool, event, context);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("deleted_at IS NULL"),
        expect.any(Array)
      );
    });

    it("should handle errors gracefully", async () => {
      const { event, context } = createMockPostDeletedEvent();
      mockQuery.mockRejectedValueOnce(new Error("DB error"));

      await expect(handlePostDeleted(mockPool, event, context)).rejects.toThrow("DB error");
    });

    // ── Soft-delete semantics (issue #74) ──────────────────────────────────────
    //
    // The contract emits PostDeleted for every successful on-chain delete, but
    // the on-chain `delete_post` is a hard-remove (the post entry is removed
    // from storage entirely).  This means the indexer's soft-delete is a
    // *defensive* signal: when the DB row still exists at the time of the
    // event (e.g. replication lag), the handler should set `deleted_at`.  When
    // the row has already been removed the idempotent skip is safe.  These
    // tests pin that semantics so regressions in either direction are loud.

    it("issues the same UPDATE shape for both first delete and replay", async () => {
      const { event, context } = createMockPostDeletedEvent(7n, "GTEST123");
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await handlePostDeleted(mockPool, event, context);
      const firstCall = mockQuery.mock.calls[0];

      mockQuery.mockResolvedValueOnce({ rowCount: 0 });
      await handlePostDeleted(mockPool, event, context);
      const secondCall = mockQuery.mock.calls[1];

      // The SQL shape and parameter order must be identical for both
      // branches — only the rowCount changes.
      expect(firstCall[0]).toBe(secondCall[0]);
      expect(firstCall[1]).toEqual(secondCall[1]);
    });

    it("uses provided timestamp for deleted_at (not NOW()) for deterministic event-time semantics", async () => {
      const fixedDate = new Date("2026-01-15T12:00:00.000Z");
      const { event, context } = createMockPostDeletedEvent(1n, "GTEST123");
      const customized = { ...context, timestamp: fixedDate };
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await handlePostDeleted(mockPool, event, customized);

      // The first parameter must be the event timestamp, not the current
      // server time, so the soft-delete reflects when the on-chain event
      // happened (not when the indexer saw it).
      expect(mockQuery.mock.calls[0][1][0]).toBe(fixedDate);
    });
  });
});

/**
 * Replay safety for post creation (BE-02).
 *
 * A post's id is assigned by the contract and is unique, so `(id)` is the
 * identity of "this post was created". N deliveries must converge on the state
 * that one delivery produces � in particular a redelivery must not reset the
 * engagement counters, which have been moving forward since the post was
 * created.
 */
describe("handlePostCreated � replay safety (BE-02)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("resolves the insert conflict in the same statement as the insert", async () => {
    // Atomicity is the point: a redelivery racing the original must not be able
    // to insert a second row between the check and the write.
    const { event, context } = createMockPostCreatedEvent(7n, "GTEST123");
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    await handlePostCreated(mockPool, event, context);

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ON CONFLICT (id) DO NOTHING");
    expect(sql).toContain("RETURNING id");
  });

  it("never writes counters on the conflict path", async () => {
    const { event, context } = createMockPostCreatedEvent(7n, "GTEST123");
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });

    await handlePostCreated(mockPool, event, context);

    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    // The statement carries the initial 0/0 counters, and DO NOTHING means the
    // existing row — with whatever engagement it has accumulated — is untouched.
    expect(values[3]).toBe(0);
    expect(values[4]).toBe(0);
    expect(sql).not.toContain("UPDATE");
  });

  it("treats a burst of identical deliveries as a single post", async () => {
    const { event, context } = createMockPostCreatedEvent(11n, "GTEST123");

    // First delivery inserts; every redelivery hits the conflict path.
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    for (let i = 0; i < 4; i += 1) {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    }

    for (let i = 0; i < 5; i += 1) {
      await handlePostCreated(mockPool, event, context);
    }

    expect(mockQuery).toHaveBeenCalledTimes(5);
    // Same parameters every time: the event identity is the only thing that
    // decides, and it never changes across deliveries.
    const parameterSets = mockQuery.mock.calls.map((call) => JSON.stringify(call[1], bigintReplacer));
    expect(new Set(parameterSets).size).toBe(1);
  });

  it("distinguishes a replay from a first delivery by the returned row count", async () => {
    const { event, context } = createMockPostCreatedEvent(3n, "GTEST123");

    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await expect(handlePostCreated(mockPool, event, context)).resolves.toBeUndefined();

    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    await expect(handlePostCreated(mockPool, event, context)).resolves.toBeUndefined();
  });

  it("propagates a database failure so the delivery is retried", async () => {
    const { event, context } = createMockPostCreatedEvent(5n, "GTEST123");
    mockQuery.mockRejectedValueOnce(new Error("connection reset"));

    await expect(handlePostCreated(mockPool, event, context)).rejects.toThrow("connection reset");
  });
});

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

describe("post identifier validation (BE-029)", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("validatePostId", () => {
    it("accepts the smallest and largest valid ids in every supported form", () => {
      expect(validatePostId(1n)).toBe(1n);
      expect(validatePostId(1)).toBe(1n);
      expect(validatePostId("1")).toBe(1n);
      expect(validatePostId(MAX_POST_ID)).toBe(MAX_POST_ID);
      expect(validatePostId(MAX_POST_ID.toString())).toBe(MAX_POST_ID);
    });

    it("rejects malformed ids", () => {
      const bad: unknown[] = [0n, -1n, 0, -5, 1.5, NaN, Infinity, "", " 1", "1.5", "abc", "-1", "0x10", MAX_POST_ID + 1n, null, undefined, {}, [], true];
      for (const value of bad) {
        expect(() => validatePostId(value)).toThrow(/Invalid post id/);
      }
    });

    it("rejects an unsafe-integer number that would lose precision", () => {
      expect(() => validatePostId(2 ** 60)).toThrow(/safe integer/);
    });
  });

  describe("handlePostCreated", () => {
    it("never touches the database for a malformed id", async () => {
      const { event, context } = createMockPostCreatedEvent(1n);
      for (const id of [0n, -3n, MAX_POST_ID + 1n]) {
        await expect(handlePostCreated(mockPool, { ...event, id }, context)).rejects.toThrow(/Invalid post id/);
      }
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("rejects an empty author before persistence", async () => {
      const { event, context } = createMockPostCreatedEvent(1n);
      await expect(handlePostCreated(mockPool, { ...event, author: "  " }, context)).rejects.toThrow(/author/);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("inserts a valid id as its decimal string", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      const { event, context } = createMockPostCreatedEvent(MAX_POST_ID);
      await handlePostCreated(mockPool, event, context);
      expect(mockQuery.mock.calls[0][1][0]).toBe(MAX_POST_ID.toString());
    });

    it("treats a duplicate valid id as a skipped replay, not an error", async () => {
      mockQuery.mockResolvedValue({ rowCount: 0 });
      const { event, context } = createMockPostCreatedEvent(7n);
      await expect(handlePostCreated(mockPool, event, context)).resolves.toBeUndefined();
      await expect(handlePostCreated(mockPool, event, context)).resolves.toBeUndefined();
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
  });

  describe("handlePostDeleted", () => {
    it("never touches the database for a malformed post_id", async () => {
      const { event, context } = createMockPostDeletedEvent(1n);
      await expect(handlePostDeleted(mockPool, { ...event, post_id: 0n }, context)).rejects.toThrow(/Invalid post post_id/);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("still deletes a valid post id", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      const { event, context } = createMockPostDeletedEvent(42n);
      await handlePostDeleted(mockPool, event, context);
      expect(mockQuery.mock.calls[0][1][1]).toBe("42");
    });
  });
});
