/**
 * Tests for the rewritten `useFeed` hook.
 *
 * The hook is expected to fetch real data from the indexer REST API rather
 * than the previously inlined mock `ALL_POSTS` array. These tests exercise:
 *   - Successful pagination using the indexer's `has_more` flag.
 *   - Surfacing indexer errors as typed `IndexerError`s via `errorCode`.
 *   - The deletion-notification bus used by `useDeletePost`.
 */

import { act, renderHook, waitFor } from "@testing-library/react-native";

import { IndexerError } from "../../../packages/sdk/src/errors";
import { markFeedPostDeleted, subscribeToFeedPostChanges, useFeed } from "../hooks/useFeed";
import * as indexerClient from "../utils/indexerClient";

jest.mock("../utils/indexerClient", () => {
  const actual = jest.requireActual("../utils/indexerClient");
  return { ...actual, listPosts: jest.fn() };
});

const mockedListPosts = indexerClient.listPosts as jest.MockedFunction<
  typeof indexerClient.listPosts
>;

const samplePost = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  author: "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOP",
  username: "GABCD…LMNO",
  content: `Body of ${id}`,
  tip_total: "0",
  like_count: 0,
  created_at: new Date(1700000000 * 1000).toISOString(),
  deleted: false,
  ...overrides,
});

describe("useFeed", () => {
  beforeEach(() => {
    mockedListPosts.mockReset();
  });

  it("loads the first page from the indexer on mount", async () => {
    mockedListPosts.mockResolvedValueOnce({
      posts: [samplePost("1"), samplePost("2")],
      total: 2,
      hasMore: false,
    });

    const { result } = renderHook(() => useFeed());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockedListPosts).toHaveBeenCalledWith(expect.any(Number), 0, expect.any(Object));
    expect(result.current.posts.map((p) => String(p.id))).toEqual(["1", "2"]);
    expect(result.current.error).toBeNull();
    expect(result.current.hasMore).toBe(false);
  });

  it("appends the next page on loadMore and stops when has_more is false", async () => {
    mockedListPosts.mockResolvedValueOnce({
      posts: [samplePost("1"), samplePost("2")],
      total: 3,
      hasMore: true,
    });

    const { result } = renderHook(() => useFeed());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockedListPosts.mockResolvedValueOnce({
      posts: [samplePost("3")],
      total: 3,
      hasMore: false,
    });

    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => expect(result.current.posts).toHaveLength(3));
    expect(mockedListPosts).toHaveBeenLastCalledWith(expect.any(Number), 2, expect.any(Object));
    expect(result.current.hasMore).toBe(false);
  });

  it("surfaces IndexerError status codes to the caller", async () => {
    mockedListPosts.mockRejectedValueOnce(new IndexerError("Indexer: service unavailable", 503));

    const { result } = renderHook(() => useFeed());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.errorCode).toBe(503);
    expect(result.current.error).toMatch(/service unavailable/i);
    expect(result.current.posts).toEqual([]);
  });

  it("falls back to a friendly generic message when the error is not an IndexerError", async () => {
    mockedListPosts.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useFeed());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/failed to load posts/i);
    expect(result.current.errorCode).toBeUndefined();
  });

  it("filters out posts on markFeedPostDeleted notifications", async () => {
    mockedListPosts.mockResolvedValueOnce({
      posts: [samplePost("1"), samplePost("2"), samplePost("3")],
      total: 3,
      hasMore: false,
    });

    const { result } = renderHook(() => useFeed());
    await waitFor(() => expect(result.current.posts).toHaveLength(3));

    act(() => {
      markFeedPostDeleted("2");
    });

    expect(result.current.posts.map((p) => String(p.id))).toEqual(["1", "3"]);
  });

  it("subscribers are removed when the hook unmounts", () => {
    const { unmount } = renderHook(() => useFeed());
    const spy = jest.fn();
    const unsubscribe = subscribeToFeedPostChanges(spy);

    unmount();
    unsubscribe();

    // After unmount + unsubscribe, any subsequent deletion must not throw.
    expect(() => markFeedPostDeleted("999")).not.toThrow();
  });
});

describe("postFromIndexer shape", () => {
  it("converts bigint string ids and numeric fields", async () => {
    // Importing internals to verify shape handling.
    const actual = await jest.requireActual("../utils/indexerClient");
    const post = actual.postFromIndexer({
      id: "42",
      author: "GABC…LMNO",
      content: "hi",
      tip_total: "123",
      like_count: "7",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    expect(post.id).toBe("42");
    expect(post.content).toBe("hi");
    expect(post.tip_total).toBe(123);
    expect(post.like_count).toBe(7);
    expect(typeof post.timestamp).toBe("number");
  });
});
