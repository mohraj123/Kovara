/**
 * Thin client around the Kovara indexer REST API.
 *
 * Centralises fetch calls so the rest of the mobile app does not have to
 * duplicate URL construction, error mapping, or response parsing. The indexer
 * is the canonical source for paginated, post-tx data (the SDK only fetches
 * one post at a time from the Soroban RPC).
 *
 * Environment variable:
 *   EXPO_PUBLIC_INDEXER_URL  - Base URL of the indexer (e.g. https://indexer.kovara.io).
 *                              The trailing slash is stripped automatically.
 *                              When unset, fetches will fail with `IndexerError`
 *                              so the UI can show a clear configuration error to
 *                              the user instead of silently using mock data.
 */

import { IndexerError, mapHttpError } from "../../../packages/sdk/src/errors";
import type { Post } from "../components/PostCard";

const DEFAULT_TIMEOUT_MS = 15_000;

function getBaseUrl(): string {
  const raw = process.env.EXPO_PUBLIC_INDEXER_URL;
  if (!raw) {
    throw new IndexerError(
      "EXPO_PUBLIC_INDEXER_URL is not configured. Set it in your .env to enable feed loading.",
      0
    );
  }
  return raw.replace(/\/+$/, "");
}

function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

interface IndexerPostRow {
  id: string;
  author: string;
  content: string;
  tip_total: string | number;
  like_count: string | number;
  created_at?: string | null;
  deleted?: boolean;
  deleted_at?: string | null;
}

interface IndexerListResponse {
  posts: IndexerPostRow[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

interface IndexerOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  opts: IndexerOptions = {}
): Promise<T> {
  const base = getBaseUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  // Chain the caller's signal into ours so external aborts still propagate.
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { Accept: "application/json", ...(init.headers ?? {}) },
    });

    const text = await res.text();
    if (!res.ok) {
      throw mapHttpError(res.status, text.slice(0, 500));
    }

    try {
      return JSON.parse(text) as T;
    } catch (parseErr) {
      throw new IndexerError(
        `Indexer returned malformed JSON: ${(parseErr as Error).message}`,
        res.status,
        parseErr
      );
    }
  } catch (err) {
    if (err instanceof IndexerError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new IndexerError("Indexer request was aborted or timed out", 0, err);
    }
    throw new IndexerError(`Could not reach the indexer: ${(err as Error).message}`, 0, err);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Convert an indexer row into the Post shape used by PostCard / useFeed.
 *
 * The indexer returns IDs as bigint strings and `tip_total`/`like_count`
 * can be either number or string depending on serialization. Username is not
 * stored by the indexer, so we fall back to a shortened address; profile
 * lookups can be layered in later without breaking this contract.
 */
export function postFromIndexer(row: IndexerPostRow): Post {
  const author = String(row.author ?? "");
  const createdAtMs = row.created_at ? new Date(row.created_at).getTime() : Date.now();

  return {
    id: row.id,
    author,
    // Profile display name is filled in by a separate lookup when available.
    username: shortAddress(author),
    content: String(row.content ?? ""),
    tip_total:
      typeof row.tip_total === "string" ? Number(row.tip_total) : Number(row.tip_total ?? 0),
    timestamp: Math.floor(createdAtMs / 1000),
    like_count:
      typeof row.like_count === "string" ? Number(row.like_count) : Number(row.like_count ?? 0),
  };
}

/**
 * Fetch a page of posts from the indexer using limit/offset pagination.
 *
 * @param limit  How many posts to request (1-100, the indexer caps at 100).
 * @param offset How many posts to skip before returning results.
 */
export async function listPosts(
  limit = 20,
  offset = 0,
  opts: IndexerOptions = {}
): Promise<{ posts: Post[]; total: number; hasMore: boolean }> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
  const safeOffset = Math.max(0, Math.floor(offset));
  const qs = new URLSearchParams({ limit: String(safeLimit), offset: String(safeOffset) });

  const data = await request<IndexerListResponse>(`/api/posts?${qs.toString()}`, {}, opts);
  return {
    posts: (data.posts ?? []).map(postFromIndexer),
    total: Number(data.total ?? 0),
    hasMore: Boolean(data.has_more),
  };
}

/**
 * Fetch a single post by its indexer-assigned id.
 *
 * Returns null if the indexer reports the post as soft-deleted so callers can
 * distinguish between "not found" and "deleted by its author".
 */
export async function getPostById(
  postId: string | number,
  opts: IndexerOptions = {}
): Promise<Post | null> {
  try {
    const row = await request<IndexerPostRow>(
      `/api/posts/${encodeURIComponent(String(postId))}`,
      {},
      opts
    );
    if (row.deleted || row.deleted_at) return null;
    return postFromIndexer(row);
  } catch (err) {
    if (err instanceof IndexerError && err.statusCode === 404) return null;
    throw err;
  }
}
