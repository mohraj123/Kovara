/**
 * Unit tests for tip event handler
 */

import { Pool } from "pg";
import { handleTip, createMockTipEvent, DELETED_POST_TIP_POLICY } from "../tip";

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

describe("Tip Event Handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should insert tip and increment post tip_total", async () => {
    const { event, context } = createMockTipEvent("GTIPPER", 1n, 1000000n, 25000n);

    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1 }] }); // Post exists check
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // INSERT tip
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE post
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // COMMIT

    await handleTip(mockPool, event, context);

    expect(mockQuery).toHaveBeenCalledWith("BEGIN");
    expect(mockQuery).toHaveBeenCalledWith(
      "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, deleted_at FROM posts"),
      expect.arrayContaining(["1"])
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO tips"),
      expect.arrayContaining([
        "1",
        "GTIPPER",
        "1000000",
        "25000",
        context.timestamp,
        context.txHash,
      ])
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE posts"),
      expect.arrayContaining(["1000000", "1"])
    );
    expect(mockQuery).toHaveBeenCalledWith("COMMIT");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("should be idempotent (skip duplicate tx_hash)", async () => {
    const { event, context } = createMockTipEvent();

    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1 }] }); // Post exists check
    mockQuery.mockResolvedValueOnce({ rowCount: 0 }); // INSERT tip (conflict)
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // COMMIT

    await handleTip(mockPool, event, context);

    expect(mockQuery).toHaveBeenCalledWith("BEGIN");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (tx_hash) DO NOTHING"),
      expect.any(Array)
    );
    expect(mockQuery).toHaveBeenCalledWith("COMMIT");
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("UPDATE posts SET tip_total"),
      expect.any(Array)
    );
  });

  it("should rollback on error", async () => {
    const { event, context } = createMockTipEvent();

    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1 }] }); // Post exists check
    mockQuery.mockRejectedValueOnce(new Error("DB error")); // INSERT fails
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // ROLLBACK

    await expect(handleTip(mockPool, event, context)).rejects.toThrow("DB error");

    expect(mockQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("should skip tip when post does not exist", async () => {
    const { event, context } = createMockTipEvent("GTIPPER", 999n, 1000000n, 25000n);

    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // Post not found
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // ROLLBACK

    await handleTip(mockPool, event, context);

    expect(mockQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO tips"),
      expect.any(Array)
    );
    expect(mockRelease).toHaveBeenCalled();
  });

  it("should retry on serialization failure", async () => {
    const { event, context } = createMockTipEvent("GTIPPER", 1n, 1000000n, 25000n);

    const serErr = new Error("could not serialize access");
    (serErr as any).code = "40001";

    // First attempt
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1 }] }); // Post exists check
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // INSERT tip
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE post
    mockQuery.mockRejectedValueOnce(serErr); // COMMIT fails with serialization error
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // ROLLBACK

    // Second attempt
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // SET TRANSACTION ISOLATION LEVEL SERIALIZABLE
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1 }] }); // Post exists check
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // INSERT tip (idempotent)
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE post
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // COMMIT

    await handleTip(mockPool, event, context);

    expect(mockConnect).toHaveBeenCalledTimes(2);
  });
});

describe("tips for deleted posts (BE-028)", () => {
  beforeEach(() => jest.clearAllMocks());

  function script(postRows: unknown[] | null) {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rowCount: 0 }); // SET TRANSACTION
    mockQuery.mockResolvedValueOnce(
      postRows === null ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: postRows }
    ); // SELECT post
  }

  it("documents the reject policy", () => {
    expect(DELETED_POST_TIP_POLICY).toBe("reject");
  });

  it("rejects a tip on a soft-deleted post: no insert, no total change, rolled back", async () => {
    const { event, context } = createMockTipEvent("GTIPPER", 5n, 1_000_000n, 25_000n);
    script([{ id: 5, deleted_at: new Date("2024-01-01") }]);
    mockQuery.mockResolvedValueOnce({ rowCount: 0 }); // ROLLBACK

    await expect(handleTip(mockPool, event, context)).resolves.toBe("rejected_deleted");

    expect(mockQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(mockQuery).not.toHaveBeenCalledWith("COMMIT");
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO tips"), expect.any(Array));
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE posts"), expect.any(Array));
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("reports a missing post as rejected_missing", async () => {
    const { event, context } = createMockTipEvent("GTIPPER", 404n);
    script(null);
    mockQuery.mockResolvedValueOnce({ rowCount: 0 }); // ROLLBACK
    await expect(handleTip(mockPool, event, context)).resolves.toBe("rejected_missing");
  });

  it("records a tip on an active post and adds it to the total", async () => {
    const { event, context } = createMockTipEvent("GTIPPER", 1n, 700n, 10n);
    script([{ id: 1, deleted_at: null }]);
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9 }] }); // INSERT tip
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE post
    mockQuery.mockResolvedValueOnce({ rowCount: 0 }); // COMMIT

    await expect(handleTip(mockPool, event, context)).resolves.toBe("recorded");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET tip_total = tip_total + $1"),
      ["700", "1"]
    );
    expect(mockQuery).toHaveBeenCalledWith("COMMIT");
  });

  it("reports a replayed tx as duplicate without touching the total", async () => {
    const { event, context } = createMockTipEvent("GTIPPER", 1n);
    script([{ id: 1, deleted_at: null }]);
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // INSERT conflict
    mockQuery.mockResolvedValueOnce({ rowCount: 0 }); // COMMIT
    await expect(handleTip(mockPool, event, context)).resolves.toBe("duplicate");
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE posts"), expect.any(Array));
  });
});
