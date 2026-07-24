import type { Pool, Post, Profile } from "../db";

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

export interface PoolResponse extends Pool {
  token_name?: string;
  token_symbol?: string;
  token_decimals?: number;
}

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
  next_offset: number | null;
  prev_offset: number | null;
}
