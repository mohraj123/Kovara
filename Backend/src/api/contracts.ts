import type { Post, Profile, PoolRecord } from "../db";

// ── Shared response types ────────────────────────────────────────────────────

/** Standard error response body returned for all 4xx / 5xx responses. */
export interface ApiErrorResponse {
  error: string;
  code: string;
}

/** Shared pagination envelope included in list responses. */
export interface PaginationResponse {
  limit: number;
  offset: number;
  has_more: boolean;
}

// ── Resource response types ──────────────────────────────────────────────────

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
  next_offset: number | null;
  prev_offset: number | null;
}

export interface FollowingResponse extends PaginationResponse {
  address: string;
  following: string[];
  total: number;
  next_offset: number | null;
  prev_offset: number | null;
}

export interface PoolResponse extends PoolRecord {}

export interface PoolListResponse extends PaginationResponse {
  pools: PoolRecord[];
  total: number;
}

// ── Debug snapshot (BE-29) ───────────────────────────────────────────────────

export interface DebugSnapshot {
  posts: Post[];
  profiles: Profile[];
  pools: PoolRecord[];
  generated_at: string;
  post_count: number;
  profile_count: number;
  pool_count: number;
}

// ── Pool validation helpers ──────────────────────────────────────────────────

export interface PoolValidationResult { valid: boolean; errors: string[]; }

export function validatePoolAdmins(admins: unknown): PoolValidationResult {
  const errors: string[] = [];
  if (!Array.isArray(admins)) {
    errors.push("admins must be an array");
    return { valid: false, errors };
  }
  if (admins.length === 0) errors.push("admins must not be empty");
  const seen = new Set<string>();
  for (const [i, a] of admins.entries()) {
    if (typeof a !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(a)) {
      errors.push(`invalid address at ${i}`);
    } else {
      const k = a.toLowerCase();
      if (seen.has(k)) errors.push(`duplicate address at ${i}`);
      seen.add(k);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validatePoolThreshold(threshold: unknown, adminCount: number): PoolValidationResult {
  const errors: string[] = [];
  if (typeof threshold !== "number" || !Number.isInteger(threshold)) {
    errors.push("threshold must be an integer");
    return { valid: false, errors };
  }
  if (threshold < 1) errors.push("threshold must be at least 1");
  if (threshold > adminCount) errors.push("threshold cannot exceed admin count");
  return { valid: errors.length === 0, errors };
}
