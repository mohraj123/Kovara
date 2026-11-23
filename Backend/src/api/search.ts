import type { PoolRecord, Post, Profile } from "../db";
import { MAX_QUERY_LENGTH, normalizeQuery } from "../search/store";

export interface ApiErrorResponse {
  error: string;
  code: string;
}

export interface PaginationResponse {
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface ProfileResponse extends Profile {}

export interface PostResponse extends Post {}

export interface PostListResponse extends PaginationResponse {
  posts: Post[];
  total: number;
}

export interface FollowersResponse extends PaginationResponse {
  address: string;
  followers: string[];
  total: number;
}

export interface FollowingResponse extends PaginationResponse {
  address: string;
  following: string[];
  total: number;
}

export interface PoolResponse extends PoolRecord {}

export interface SearchPost {
  id: number;
  author: string;
  content: string;
  tip_total: string;
  timestamp: number;
}

export interface SearchResponse {
  posts: SearchPost[];
  total: number;
  has_more: boolean;
}

/** Longest accepted search phrase, after normalization. */
export const MAX_SEARCH_PHRASE_LENGTH = MAX_QUERY_LENGTH;

export class SearchPhraseError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID_QUERY" | "QUERY_TOO_LONG"
  ) {
    super(message);
    this.name = "SearchPhraseError";
  }
}

/**
 * Normalize and bound a user-supplied search phrase before any database search
 * expression is built from it: trim, collapse runs of whitespace to a single
 * space, then reject empty phrases and phrases longer than
 * {@link MAX_SEARCH_PHRASE_LENGTH} (measured after normalization, so padding
 * cannot push a valid phrase over the limit).
 */
export function normalizeSearchPhrase(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new SearchPhraseError("search phrase is required and must be a string", "INVALID_QUERY");
  }
  const phrase = normalizeQuery(raw);
  if (phrase === "") {
    throw new SearchPhraseError("search phrase cannot be empty", "INVALID_QUERY");
  }
  if (phrase.length > MAX_SEARCH_PHRASE_LENGTH) {
    throw new SearchPhraseError(
      `search phrase cannot exceed ${MAX_SEARCH_PHRASE_LENGTH} characters`,
      "QUERY_TOO_LONG"
    );
  }
  return phrase;
}
