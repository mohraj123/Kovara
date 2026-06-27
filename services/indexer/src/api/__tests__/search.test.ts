import http from "http";
import { AddressInfo } from "net";
import { createApp } from "../index";
import { Database } from "../../db";

describe("POST /api/search/posts", () => {
  const db = {
    upsertProfile: jest.fn(),
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
    addPoolAdmin: jest.fn(),
    removePoolAdmin: jest.fn(),
    getProfile: jest.fn(),
    listPosts: jest.fn(),
    getFollowers: jest.fn(),
    getFollowing: jest.fn(),
    searchPosts: jest.fn().mockResolvedValue({
      posts: [
        {
          id: 42n,
          author: "GABC...XYZ",
          content: "Building on Stellar with Soroban is great!",
          tip_total: 1000000000n,
          like_count: 7n,
          created_at: new Date("2024-01-01T00:00:00.000Z"),
          deleted_at: null,
        },
      ],
      total: 1,
    }),
  } as unknown as Database;

  it("returns search results from the database", async () => {
    const app = createApp(db);
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));

    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/search/posts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "stellar soroban", limit: 10, offset: 0 }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        posts: [
          {
            id: "42",
            author: "GABC...XYZ",
            content: "Building on Stellar with Soroban is great!",
            tip_total: "1000000000",
            like_count: 7,
            created_at: "2024-01-01T00:00:00.000Z",
            deleted: false,
          },
        ],
        total: 1,
        has_more: false,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
