/**
 * Unit tests for tip event handler
 */

import { Pool } from "pg";
import { handleTip, createMockTipEvent } from "../tip";

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
      expect.stringContaining("SELECT id FROM posts"),
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
