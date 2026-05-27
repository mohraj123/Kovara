/**
 * Unit tests for the post event handlers.
 *
 * Issue #351 — acceptance criteria:
 *  - Happy path tested (PostCreated and PostDeleted)
 *  - Idempotency tested
 *  - Database calls mocked with jest.mock
 */

import { handlePostCreated, handlePostDeleted, PostCreatedEvent, PostDeletedEvent } from "../post";
import { Database } from "../../db";

jest.mock("../../db");

function makeMockDb(): jest.Mocked<Database> {
  return {
    upsertProfile: jest.fn(),
    insertFollow: jest.fn(),
    deleteFollow: jest.fn(),
    insertPost: jest.fn().mockResolvedValue(undefined),
    markPostDeleted: jest.fn().mockResolvedValue(undefined),
    incrementPostLikeCount: jest.fn(),
    addPostTipTotal: jest.fn(),
    getPost: jest.fn(),
    upsertLike: jest.fn(),
    insertTip: jest.fn(),
    upsertPool: jest.fn(),
    adjustPoolBalance: jest.fn(),
  } as jest.Mocked<Database>;
}

// ── handlePostCreated ─────────────────────────────────────────────────────────

describe("handlePostCreated", () => {
  let db: jest.Mocked<Database>;

  beforeEach(() => {
    db = makeMockDb();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("calls db.insertPost with correct fields", async () => {
    const event: PostCreatedEvent = {
      id: BigInt(1),
      author: "GABC123",
      ledger: 500,
    };

    await handlePostCreated(db, event);

    expect(db.insertPost).toHaveBeenCalledTimes(1);
    expect(db.insertPost).toHaveBeenCalledWith({
      id: BigInt(1),
      author: "GABC123",
      deleted: false,
      tip_total: BigInt(0),
      like_count: BigInt(0),
      created_ledger: 500,
      deleted_ledger: null,
    });
  });

  it("resolves without error for a valid event", async () => {
    const event: PostCreatedEvent = {
      id: BigInt(42),
      author: "GXYZ789",
      ledger: 1000,
    };

    await expect(handlePostCreated(db, event)).resolves.toBeUndefined();
  });

  it("inserts post with deleted=false and zero counters", async () => {
    const event: PostCreatedEvent = {
      id: BigInt(7),
      author: "GABC123",
      ledger: 300,
    };

    await handlePostCreated(db, event);

    const call = db.insertPost.mock.calls[0][0];
    expect(call.deleted).toBe(false);
    expect(call.tip_total).toBe(BigInt(0));
    expect(call.like_count).toBe(BigInt(0));
    expect(call.deleted_ledger).toBeNull();
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  it("is idempotent — replaying the same event calls insertPost again", async () => {
    const event: PostCreatedEvent = {
      id: BigInt(1),
      author: "GABC123",
      ledger: 500,
    };

    await handlePostCreated(db, event);
    await handlePostCreated(db, event);

    // Handler delegates idempotency to the db layer (upsert).
    expect(db.insertPost).toHaveBeenCalledTimes(2);
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("throws when author field is missing", async () => {
    const event = {
      id: BigInt(1),
      author: "",
      ledger: 500,
    } as PostCreatedEvent;

    await expect(handlePostCreated(db, event)).rejects.toThrow(
      "PostCreated event missing required field: author"
    );
    expect(db.insertPost).not.toHaveBeenCalled();
  });

  // ── Database error propagation ──────────────────────────────────────────────

  it("propagates database errors", async () => {
    db.insertPost.mockRejectedValueOnce(new Error("unique constraint violation"));

    const event: PostCreatedEvent = {
      id: BigInt(1),
      author: "GABC123",
      ledger: 500,
    };

    await expect(handlePostCreated(db, event)).rejects.toThrow(
      "unique constraint violation"
    );
  });
});

// ── handlePostDeleted ─────────────────────────────────────────────────────────

describe("handlePostDeleted", () => {
  let db: jest.Mocked<Database>;

  beforeEach(() => {
    db = makeMockDb();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("calls db.markPostDeleted with correct post_id and ledger", async () => {
    const event: PostDeletedEvent = {
      post_id: BigInt(5),
      author: "GABC123",
      ledger: 800,
    };

    await handlePostDeleted(db, event);

    expect(db.markPostDeleted).toHaveBeenCalledTimes(1);
    expect(db.markPostDeleted).toHaveBeenCalledWith(BigInt(5), 800);
  });

  it("resolves without error for a valid event", async () => {
    const event: PostDeletedEvent = {
      post_id: BigInt(10),
      author: "GXYZ789",
      ledger: 900,
    };

    await expect(handlePostDeleted(db, event)).resolves.toBeUndefined();
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  it("is idempotent — replaying the same delete event calls markPostDeleted again", async () => {
    const event: PostDeletedEvent = {
      post_id: BigInt(5),
      author: "GABC123",
      ledger: 800,
    };

    await handlePostDeleted(db, event);
    await handlePostDeleted(db, event);

    expect(db.markPostDeleted).toHaveBeenCalledTimes(2);
    expect(db.markPostDeleted).toHaveBeenNthCalledWith(1, BigInt(5), 800);
    expect(db.markPostDeleted).toHaveBeenNthCalledWith(2, BigInt(5), 800);
  });

  // ── Database error propagation ──────────────────────────────────────────────

  it("propagates database errors", async () => {
    db.markPostDeleted.mockRejectedValueOnce(new Error("post not found"));

    const event: PostDeletedEvent = {
      post_id: BigInt(999),
      author: "GABC123",
      ledger: 800,
    };

    await expect(handlePostDeleted(db, event)).rejects.toThrow("post not found");
  });
});
