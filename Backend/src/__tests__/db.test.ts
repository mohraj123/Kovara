import { Pool } from "pg";
import { PostgresDatabase } from "../db";

describe("PostgresDatabase.insertPost", () => {
  const postRow = {
    id: "7",
    author: "GAUTHOR",
    content: "hello",
    tip_total: "12",
    like_count: "3",
    created_ledger: 456,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    deleted_at: null,
  };

  const post = {
    id: 7n,
    author: "GAUTHOR",
    content: "hello",
    deleted: false,
    tip_total: 12n,
    like_count: 3n,
    created_ledger: 456,
    deleted_ledger: null,
  };

  it("persists and reads the post creation ledger", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [postRow] });
    const database = new PostgresDatabase({ query } as unknown as Pool);

    await database.insertPost(post);

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("created_ledger, created_at"),
      ["7", "GAUTHOR", "hello", "12", "3", 456, null]
    );
    await expect(database.getPost(7n)).resolves.toMatchObject({
      created_ledger: 456,
      tip_total: 12n,
      like_count: 3n,
    });
  });

  it("keeps a cached post when the write fails", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [postRow] })
      .mockRejectedValueOnce(new Error("write failed"));
    const database = new PostgresDatabase({ query } as unknown as Pool);

    await database.getPost(7n);
    await expect(database.incrementPostLikeCount(7n)).rejects.toThrow("write failed");
    await expect(database.getPost(7n)).resolves.toMatchObject({ like_count: 3n });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("invalidates a cached post after a successful write", async () => {
    const refreshedRow = { ...postRow, like_count: "4" };
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [postRow] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [refreshedRow] });
    const database = new PostgresDatabase({ query } as unknown as Pool);

    await database.getPost(7n);
    await database.incrementPostLikeCount(7n);
    await expect(database.getPost(7n)).resolves.toMatchObject({ like_count: 4n });
    expect(query).toHaveBeenCalledTimes(3);
  });
});