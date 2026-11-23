import { Pool } from "pg";
import { ResponseCache } from "../cache/response-cache";
import { PostgresDatabase } from "../db";

describe("ResponseCache capacity", () => {
  it("evicts fully expired entries before live entries when over capacity", async () => {
    const cache = new ResponseCache({
      ttlMs: 100,
      staleWhileRevalidateMs: 0,
      maxEntries: 2,
      readEpoch: async () => 0,
    });
    const now = jest.spyOn(Date, "now");

    try {
      now.mockReturnValue(1_000);
      await cache.get("live-oldest", async () => "live");

      now.mockReturnValue(950);
      await cache.get("expired-newer", async () => "expired");

      now.mockReturnValue(1_055);
      await cache.get("incoming", async () => "new");

      expect(cache.stats().keys).toEqual(["live-oldest", "incoming"]);
      expect(cache.stats().size).toBe(2);
      expect(cache.stats().evictions).toBe(1);
    } finally {
      now.mockRestore();
    }
  });
});

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

describe("PostgresDatabase.withTransaction (BE-53)", () => {
  function setup(failOn?: string, failRollback = false) {
    const clientQueries: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        clientQueries.push(sql);
        if (failOn && sql.includes(failOn)) throw new Error(`failed: ${failOn}`);
        if (failRollback && sql === "ROLLBACK") throw new Error("rollback failed");
        return { rowCount: 1, rows: [] };
      }),
      release: jest.fn(),
    };
    const poolQuery = jest.fn(async (sql: string) => {
      if (sql.includes("cache_epoch") && sql.includes("SELECT")) return { rows: [{ epoch: "0" }], rowCount: 1 };
      return { rowCount: 1, rows: [] };
    });
    const pool = { query: poolQuery, connect: jest.fn(async () => client) };
    return { database: new PostgresDatabase(pool as unknown as Pool), client, clientQueries, poolQuery };
  }

  const twoStepWrite = async (client: { query: (sql: string) => Promise<unknown> }) => {
    await client.query("INSERT INTO tips (step) VALUES (1)");
    await client.query("UPDATE posts SET tip_total = tip_total + 1");
    return "done";
  };

  it("commits every step together when nothing fails", async () => {
    const { database, client, clientQueries } = setup();

    await expect(database.withTransaction(twoStepWrite)).resolves.toBe("done");

    expect(clientQueries).toEqual([
      "BEGIN",
      "INSERT INTO tips (step) VALUES (1)",
      "UPDATE posts SET tip_total = tip_total + 1",
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it("rolls back the earlier writes when a later step fails", async () => {
    const { database, client, clientQueries } = setup("UPDATE posts");

    await expect(database.withTransaction(twoStepWrite)).rejects.toThrow("failed: UPDATE posts");

    // The first INSERT ran, so it must be undone, and the commit must never happen.
    expect(clientQueries).toEqual([
      "BEGIN",
      "INSERT INTO tips (step) VALUES (1)",
      "UPDATE posts SET tip_total = tip_total + 1",
      "ROLLBACK",
    ]);
    expect(clientQueries).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back when the commit itself fails", async () => {
    const { database, clientQueries } = setup("COMMIT");

    await expect(database.withTransaction(twoStepWrite)).rejects.toThrow("failed: COMMIT");

    expect(clientQueries[clientQueries.length - 1]).toBe("ROLLBACK");
  });

  it("does not touch the shared cache epoch when the transaction fails", async () => {
    const { database, poolQuery } = setup("UPDATE posts");

    await expect(database.withTransaction(twoStepWrite)).rejects.toThrow();

    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("destroys the connection when the rollback fails, and still reports the original error", async () => {
    const { database, client } = setup("UPDATE posts", true);

    await expect(database.withTransaction(twoStepWrite)).rejects.toThrow("failed: UPDATE posts");

    expect(client.release).toHaveBeenCalledWith(true);
  });
});
