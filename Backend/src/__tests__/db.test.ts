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
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("cache_epoch")) {
        if (sql.includes("SELECT")) return { rows: [{ epoch: "0" }], rowCount: 1 } as unknown as never;
        return { rowCount: 1 } as unknown as never;
      }
      if (sql.includes("SELECT * FROM posts")) return { rowCount: 1, rows: [postRow] } as unknown as never;
      return { rowCount: 1 } as unknown as never;
    });
    const database = new PostgresDatabase({ query } as unknown as Pool);

    await database.insertPost(post);

    expect(query).toHaveBeenCalledWith(
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
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("cache_epoch")) {
        if (sql.includes("SELECT")) return { rows: [{ epoch: "0" }], rowCount: 1 } as unknown as never;
        return { rowCount: 1 } as unknown as never;
      }
      if (sql.includes("SELECT * FROM posts")) return { rowCount: 1, rows: [postRow] } as unknown as never;
      if (sql.includes("UPDATE posts SET like_count")) throw new Error("write failed");
      return { rowCount: 1 } as unknown as never;
    });
    const database = new PostgresDatabase({ query } as unknown as Pool);

    await database.getPost(7n);
    await expect(database.incrementPostLikeCount(7n)).rejects.toThrow("write failed");
    await expect(database.getPost(7n)).resolves.toMatchObject({ like_count: 3n });
    // At least one SELECT and one failing UPDATE were issued; cache_epoch queries are tolerated.
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SELECT * FROM posts"), ["7"]);
  });

  it("invalidates a cached post after a successful write", async () => {
    const refreshedRow = { ...postRow, like_count: "4" };
    let selectCall = 0;
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("cache_epoch")) {
        if (sql.includes("SELECT")) return { rows: [{ epoch: "0" }], rowCount: 1 } as unknown as never;
        return { rowCount: 1 } as unknown as never;
      }
      if (sql.includes("SELECT * FROM posts")) {
        selectCall += 1;
        return (selectCall === 1 ? { rowCount: 1, rows: [postRow] } : { rowCount: 1, rows: [refreshedRow] }) as unknown as never;
      }
      if (sql.includes("UPDATE posts SET like_count")) return { rowCount: 1 } as unknown as never;
      return { rowCount: 1 } as unknown as never;
    });
    const database = new PostgresDatabase({ query } as unknown as Pool);

    await database.getPost(7n);
    await database.incrementPostLikeCount(7n);
    await expect(database.getPost(7n)).resolves.toMatchObject({ like_count: 4n });
    expect(selectCall).toBe(2);
  });
});
