import { AddressInfo } from "net";
import type { Database } from "../../db";
import { createApp } from "../index";

describe("POST /api/search/posts", () => {
  let baseUrl: string;
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

  beforeAll(() => {
    const db = {
      getProfile: jest.fn().mockResolvedValue(null),
      listPosts: jest.fn().mockResolvedValue({ posts: [], total: 0 }),
      getFollowers: jest.fn().mockResolvedValue({ followers: [], total: 0 }),
      getFollowing: jest.fn().mockResolvedValue({ following: [], total: 0 }),
    } as unknown as Database;

    const app = createApp(db);
    server = app.listen(0);

    return new Promise<void>((resolve) => {
      server.once("listening", () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    server.close();
  });

  async function postSearch(body: Record<string, unknown>) {
    const response = await fetch(`${baseUrl}/api/search/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  it("returns the search response contract with default paging values", async () => {
    const response = await postSearch({ query: "hello world" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        posts: [],
        total: 0,
        has_more: false,
        limit: 20,
        offset: 0,
      })
    );
  });

  it("echoes custom paging values in the search response", async () => {
    const response = await postSearch({ query: "hello world", limit: 2, offset: 3 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      limit: 2,
      offset: 3,
    });
  });

  it("returns a validation error for invalid paging values", async () => {
    const response = await postSearch({ query: "hello world", limit: 0, offset: -1 });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: "INVALID_QUERY",
    });
  });
});
