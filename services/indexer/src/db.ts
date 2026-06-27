/**
 * Database interface for the Kovara indexer.
 *
 * All methods are async so implementations can use any storage backend
 * (PostgreSQL, SQLite, in-memory, etc.). The handler tests mock this
 * interface with jest.mock so no real database is required during testing.
 */

import { Pool } from "pg";

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
  content: string;
  deleted: boolean;
  tip_total: bigint;
  like_count: bigint;
  created_ledger: number;
  deleted_ledger: number | null;
  created_at?: Date | null;
  deleted_at?: Date | null;
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

export interface PoolRecord {
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
  upsertPool(pool: PoolRecord): Promise<void>;
  adjustPoolBalance(pool_id: string, delta: bigint, ledger: number): Promise<void>;
  insertPool(pool: PoolRecord): Promise<void>;
  getPool(pool_id: string): Promise<PoolRecord | null>;
  addPoolAdmin(pool_id: string, admin: string, ledger: number): Promise<void>;
  removePoolAdmin(pool_id: string, admin: string, ledger: number): Promise<void>;

  // Query methods used by the REST API
  getProfile(address: string): Promise<Profile | null>;
  listPosts(filters: {
    author?: string;
    limit: number;
    offset: number;
  }): Promise<{ posts: Post[]; total: number }>;
  searchPosts(filters: {
    query: string;
    limit: number;
    offset: number;
  }): Promise<{ posts: Post[]; total: number }>;
  getFollowers(
    address: string,
    limit: number,
    offset: number
  ): Promise<{ followers: string[]; total: number }>;
  getFollowing(
    address: string,
    limit: number,
    offset: number
  ): Promise<{ following: string[]; total: number }>;
}

export class PostgresDatabase implements Database {
  constructor(private readonly pool: Pool) {}

  private toBigInt(value: unknown): bigint {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    if (typeof value === "string") return BigInt(value);
    throw new Error(`Unsupported bigint value: ${String(value)}`);
  }

  private mapPost(row: Record<string, unknown>): Post {
    return {
      id: this.toBigInt(row.id),
      author: String(row.author ?? ""),
      content: String(row.content ?? ""),
      deleted: row.deleted_at !== null && row.deleted_at !== undefined,
      tip_total: this.toBigInt(row.tip_total ?? 0),
      like_count: this.toBigInt(row.like_count ?? 0),
      created_ledger: Number(row.created_ledger ?? 0),
      deleted_ledger: row.deleted_ledger === null || row.deleted_ledger === undefined ? null : Number(row.deleted_ledger),
      created_at: row.created_at instanceof Date ? row.created_at : row.created_at ? new Date(String(row.created_at)) : null,
      deleted_at: row.deleted_at instanceof Date ? row.deleted_at : row.deleted_at ? new Date(String(row.deleted_at)) : null,
    };
  }

  async upsertProfile(profile: Profile): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO profiles (address, username, creator_token, updated_ledger)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (address) DO UPDATE SET
        username = EXCLUDED.username,
        creator_token = EXCLUDED.creator_token,
        updated_ledger = EXCLUDED.updated_ledger
      `,
      [profile.address, profile.username, profile.creator_token, profile.updated_ledger]
    );
  }

  async insertFollow(follow: Follow): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO follows (follower, followee, ledger)
      VALUES ($1, $2, $3)
      ON CONFLICT (follower, followee) DO NOTHING
      `,
      [follow.follower, follow.followee, follow.ledger]
    );
  }

  async deleteFollow(follower: string, followee: string): Promise<void> {
    await this.pool.query(`DELETE FROM follows WHERE follower = $1 AND followee = $2`, [
      follower,
      followee,
    ]);
  }

  async insertPost(post: Post): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO posts (id, author, content, tip_total, like_count, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (id) DO NOTHING
      `,
      [post.id.toString(), post.author, post.content, post.tip_total.toString(), post.like_count.toString()]
    );
  }

  async markPostDeleted(post_id: bigint, deleted_ledger: number): Promise<void> {
    await this.pool.query(
      `
      UPDATE posts
      SET deleted_at = NOW(), deleted_ledger = $2
      WHERE id = $1 AND deleted_at IS NULL
      `,
      [post_id.toString(), deleted_ledger]
    );
  }

  async incrementPostLikeCount(post_id: bigint): Promise<void> {
    await this.pool.query(`UPDATE posts SET like_count = like_count + 1 WHERE id = $1`, [
      post_id.toString(),
    ]);
  }

  async addPostTipTotal(post_id: bigint, net_amount: bigint): Promise<void> {
    await this.pool.query(`UPDATE posts SET tip_total = tip_total + $2 WHERE id = $1`, [
      post_id.toString(),
      net_amount.toString(),
    ]);
  }

  async getPost(post_id: bigint): Promise<Post | null> {
    const result = await this.pool.query(`SELECT * FROM posts WHERE id = $1`, [post_id.toString()]);
    return result.rowCount ? this.mapPost(result.rows[0]) : null;
  }

  async upsertLike(like: Like): Promise<boolean> {
    const result = await this.pool.query(
      `
      INSERT INTO likes (post_id, user, ledger)
      VALUES ($1, $2, $3)
      ON CONFLICT (post_id, user) DO NOTHING
      RETURNING post_id
      `,
      [like.post_id.toString(), like.user, like.ledger]
    );
    return result.rowCount === 1;
  }

  async insertTip(tip: Tip): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO tips (tipper, post_id, amount, fee, ledger, tx_hash)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tx_hash) DO NOTHING
      `,
      [tip.tipper, tip.post_id.toString(), tip.amount.toString(), tip.fee.toString(), tip.ledger, tip.tx_hash]
    );
  }

  async upsertPool(pool: PoolRecord): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO pools (pool_id, token, balance, admins, threshold, created_ledger, updated_ledger)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (pool_id) DO UPDATE SET
        token = EXCLUDED.token,
        balance = EXCLUDED.balance,
        admins = EXCLUDED.admins,
        threshold = EXCLUDED.threshold,
        updated_ledger = EXCLUDED.updated_ledger
      `,
      [pool.pool_id, pool.token, pool.balance.toString(), pool.admins, pool.threshold, pool.created_ledger, pool.updated_ledger]
    );
  }

  async adjustPoolBalance(pool_id: string, delta: bigint, ledger: number): Promise<void> {
    await this.pool.query(
      `
      UPDATE pools
      SET balance = balance + $2, updated_ledger = $3
      WHERE pool_id = $1
      `,
      [pool_id, delta.toString(), ledger]
    );
  }

  async insertPool(pool: PoolRecord): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO pools (pool_id, token, balance, admins, threshold, created_ledger, updated_ledger)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (pool_id) DO NOTHING
      `,
      [pool.pool_id, pool.token, pool.balance.toString(), pool.admins, pool.threshold, pool.created_ledger, pool.updated_ledger]
    );
  }

  async getPool(pool_id: string): Promise<PoolRecord | null> {
    const result = await this.pool.query(`SELECT * FROM pools WHERE pool_id = $1`, [pool_id]);
    return result.rowCount ? (result.rows[0] as PoolRecord) : null;
  }

  async addPoolAdmin(pool_id: string, admin: string, ledger: number): Promise<void> {
    await this.pool.query(
      `
      UPDATE pools
      SET admins = array_append(admins, $2), updated_ledger = $3
      WHERE pool_id = $1 AND NOT (admins @> ARRAY[$2])
      `,
      [pool_id, admin, ledger]
    );
  }

  async removePoolAdmin(pool_id: string, admin: string, ledger: number): Promise<void> {
    await this.pool.query(
      `
      UPDATE pools
      SET admins = array_remove(admins, $2), updated_ledger = $3
      WHERE pool_id = $1
      `,
      [pool_id, admin, ledger]
    );
  }

  async getProfile(address: string): Promise<Profile | null> {
    const result = await this.pool.query(`SELECT * FROM profiles WHERE address = $1`, [address]);
    return result.rowCount ? (result.rows[0] as Profile) : null;
  }

  async listPosts(filters: { author?: string; limit: number; offset: number }): Promise<{ posts: Post[]; total: number }> {
    const { author, limit, offset } = filters;
    const values: unknown[] = [];
    let whereClause = "WHERE deleted_at IS NULL";

    if (author) {
      values.push(author);
      whereClause += ` AND author = $${values.length}`;
    }

    const countResult = await this.pool.query(`SELECT COUNT(*)::int AS total FROM posts ${whereClause}`, values);
    const result = await this.pool.query(
      `SELECT * FROM posts ${whereClause} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );

    return {
      posts: result.rows.map((row) => this.mapPost(row)),
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  }

  async searchPosts(filters: { query: string; limit: number; offset: number }): Promise<{ posts: Post[]; total: number }> {
    const { query, limit, offset } = filters;
    const normalizedQuery = query.trim();

    const countResult = await this.pool.query(
      `
      SELECT COUNT(*)::int AS total
      FROM posts
      WHERE deleted_at IS NULL
        AND (
          search_vector @@ plainto_tsquery('simple', $1)
          OR content ILIKE '%' || $1 || '%'
        )
      `,
      [normalizedQuery]
    );

    const result = await this.pool.query(
      `
      SELECT *
      FROM posts
      WHERE deleted_at IS NULL
        AND (
          search_vector @@ plainto_tsquery('simple', $1)
          OR content ILIKE '%' || $1 || '%'
        )
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [normalizedQuery, limit, offset]
    );

    return {
      posts: result.rows.map((row) => this.mapPost(row)),
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  }

  async getFollowers(address: string, limit: number, offset: number): Promise<{ followers: string[]; total: number }> {
    const countResult = await this.pool.query(`SELECT COUNT(*)::int AS total FROM follows WHERE followee = $1`, [address]);
    const result = await this.pool.query(
      `SELECT follower FROM follows WHERE followee = $1 ORDER BY follower LIMIT $2 OFFSET $3`,
      [address, limit, offset]
    );

    return {
      followers: result.rows.map((row) => String(row.follower)),
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  }

  async getFollowing(address: string, limit: number, offset: number): Promise<{ following: string[]; total: number }> {
    const countResult = await this.pool.query(`SELECT COUNT(*)::int AS total FROM follows WHERE follower = $1`, [address]);
    const result = await this.pool.query(
      `SELECT followee FROM follows WHERE follower = $1 ORDER BY followee LIMIT $2 OFFSET $3`,
      [address, limit, offset]
    );

    return {
      following: result.rows.map((row) => String(row.followee)),
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  }
}
