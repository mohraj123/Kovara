import { Pool as PgPool } from "pg";

/**
 * Database interface for the Linkora indexer.
 *
 * All methods are async so implementations can use any storage backend
 * (PostgreSQL, SQLite, in-memory, etc.).  The handler tests mock this
 * interface with jest.mock so no real database is required during testing.
 */

export interface Profile {
  address: string;
  username: string;
  creator_token: string;
  updated_ledger: number;
}

export interface Follow {
  follower: string;
  followee: string;
  ledger: number;
}

export interface Post {
  id: bigint;
  author: string;
  deleted: boolean;
  tip_total: bigint;
  like_count: bigint;
  created_ledger: number;
  deleted_ledger: number | null;
}

export interface Like {
  post_id: bigint;
  user: string;
  ledger: number;
}

export interface Tip {
  id?: number;
  tipper: string;
  post_id: bigint;
  amount: bigint;
  fee: bigint;
  ledger: number;
  tx_hash: string;
}

export interface Pool {
  pool_id: string;
  token: string;
  balance: bigint;
  admins: string[];
  threshold: number;
  created_ledger: number;
  updated_ledger: number;
}

export interface Database {
  // Profiles
  upsertProfile(profile: Profile): Promise<void>;

  // Follows
  insertFollow(follow: Follow): Promise<void>;
  deleteFollow(follower: string, followee: string): Promise<void>;

  // Posts
  insertPost(post: Post): Promise<void>;
  markPostDeleted(post_id: bigint, deleted_ledger: number): Promise<void>;
  incrementPostLikeCount(post_id: bigint): Promise<void>;
  addPostTipTotal(post_id: bigint, net_amount: bigint): Promise<void>;
  getPost(post_id: bigint): Promise<Post | null>;

  // Likes
  upsertLike(like: Like): Promise<boolean>; // returns true if newly inserted

  // Tips
  insertTip(tip: Tip): Promise<void>;

  // Pools
  upsertPool(pool: Pool): Promise<void>;
  adjustPoolBalance(pool_id: string, delta: bigint, ledger: number): Promise<void>;
  insertPool(pool: Pool): Promise<void>;
  getPool(pool_id: string): Promise<Pool | null>;
  addPoolAdmin(pool_id: string, admin: string, ledger: number): Promise<void>;
  removePoolAdmin(pool_id: string, admin: string, ledger: number): Promise<void>;

  // Query methods used by the REST API
  getProfile(address: string): Promise<Profile | null>;
  listPosts(filters: { author?: string; limit: number; offset: number }): Promise<{ posts: Post[]; total: number }>;
  getFollowers(address: string, limit: number, offset: number): Promise<{ followers: string[]; total: number }>;
  getFollowing(address: string, limit: number, offset: number): Promise<{ following: string[]; total: number }>;
}

export interface RawSorobanEvent {
  contractAddress: string;
  eventType: string;
  txHash: string;
  ledger: number;
  topic: unknown;
  value: unknown;
  rawEvent: unknown;
}

export interface FollowEdge {
  follower: string;
  followee: string;
  createdAt?: Date;
}

export function createPgPoolFromEnv(): PgPool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  return new PgPool({
    connectionString,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  });
}

export async function insertRawEvent(pool: PgPool, event: RawSorobanEvent): Promise<void> {
  await pool.query(
    `
      INSERT INTO events (
        contract_address,
        event_type,
        tx_hash,
        ledger,
        topic,
        value,
        raw_event
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)
      ON CONFLICT (tx_hash, ledger, event_type) DO NOTHING
    `,
    [
      event.contractAddress,
      event.eventType,
      event.txHash,
      event.ledger,
      JSON.stringify(event.topic ?? null),
      JSON.stringify(event.value ?? null),
      JSON.stringify(event.rawEvent ?? null),
    ]
  );
}

export async function upsertFollowEdge(pool: PgPool, edge: FollowEdge): Promise<void> {
  await pool.query(
    `
      INSERT INTO follows (follower, followee, created_at)
      VALUES ($1, $2, COALESCE($3, NOW()))
      ON CONFLICT (follower, followee) DO NOTHING
    `,
    [edge.follower, edge.followee, edge.createdAt ?? null]
  );
}

export async function deleteFollowEdge(pool: PgPool, edge: FollowEdge): Promise<void> {
  await pool.query("DELETE FROM follows WHERE follower = $1 AND followee = $2", [
    edge.follower,
    edge.followee,
  ]);
}
