import type { PoolRecord, Post, Profile } from "../db";
import type { PaginationResponse } from "./contracts";

export interface ThreadApiResponse {
  error: string;
  code: string;
}

export interface ThreadPagination {
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
