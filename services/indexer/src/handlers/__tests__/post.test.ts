/**
 * Unit tests for post event handlers
 */

import { Pool } from "pg";
import {
  handlePostCreated,
  handlePostDeleted,
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
