/**
 * Database interface for the Kovara indexer.
 *
 * All methods are async so implementations can use any storage backend
 * (PostgreSQL, SQLite, in-memory, etc.). The handler tests mock this
 * interface with jest.mock so no real database is required during testing.
 */
/** // const applied = await getAppliedMigrations(pool);
 * Handle a Follow event.
 *
 * Inserts a directed edge (follower → followee) into the follow graph.
 * Idempotent: if the follow already exists the handler returns immediately
 * without issuing a database write.
 */
import { Pool } from "pg";

/** Default query timeout in milliseconds (30s). */
const DEFAULT_QUERY_TIMEOUT = 30_000;

// BA-028: Convert a value to bigint without silently losing precision.
//
// PostgreSQL BIGINT holds integers up to 2^63-1, but a JavaScript `number`
// only represents integers losslessly within [-Number.MAX_SAFE_INTEGER,
// Number.MAX_SAFE_INTEGER] (2^53-1). Converting an unsafe number to BigInt
// would silently corrupt large counts such as like totals and tip totals.
//
// Rules:
//   - native bigint  → returned as-is
//   - number         → must be an integer and a safe integer, else throw
//   - integer string → parsed exactly (leading +/- allowed)
//   - anything else  → throws
export function toSafeBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `Unsafe bigint conversion: ${value} is not a safe integer (|value| > 2^53-1)`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") throw new Error(`Cannot convert empty string to bigint`);
    if (!/^[+-]?\d+$/.test(s)) {
      throw new Error(`Cannot convert non-integer string to bigint: "${value}"`);
    }
    return BigInt(s);
  }
  throw new Error(`Unsupported bigint value: ${String(value)}`);
}

// ── Simple TTL cache for frequently-accessed records ────────────────────────

class TTLCache<T> {
  private readonly store = new Map<
    string,
    { value: T; expiresAt: number; epoch: number }
  >();

  constructor(private readonly ttlMs: number) {}

  getEntry(key: string): { value: T; epoch: number } | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return { value: entry.value, epoch: entry.epoch };
  }

  get(key: string): T | undefined {
    return this.getEntry(key)?.value;
  }

  set(key: string, value: T, epoch: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs, epoch });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

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
  token_name?: string;
  token_symbol?: string;
  token_decimals?: number;
}

export interface SearchedPost {
  id: bigint;
  author: string;
  content: string;
  tip_total: bigint;
  like_count: bigint;
  created_ledger: number;
}

export interface Database {
  // Profiles
  upsertProfile(profile: Profile): Promise<void>;

  // Follows
  getFollow(follower: string, followee: string): Promise<Follow | null>;
  insertFollow(follow: Follow): Promise<void>;
  deleteFollow(follower: string, followee: string): Promise<void>;

  // Posts
  insertPost(post: Post): Promise<void>;
  markPostDeleted(post_id: bigint, deleted_ledger: number, deleted_at?: Date): Promise<void>;
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
  listPools(filters: { limit: number; offset: number }): Promise<{ pools: PoolRecord[]; total: number }>;
  addPoolAdmin(pool_id: string, admin: string, ledger: number): Promise<void>;
  removePoolAdmin(pool_id: string, admin: string, ledger: number): Promise<void>;

  // Query methods used by the REST API
  getProfile(address: string): Promise<Profile | null>;
  listProfiles(filters: { limit: number; offset: number }): Promise<{ profiles: Profile[]; total: number }>;
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
  getFollowersAfter(
    address: string,
    cursor: string,
    limit: number
  ): Promise<{ followers: string[]; total: number }>;
  getFollowingAfter(
    address: string,
    cursor: string,
    limit: number
  ): Promise<{ following: string[]; total: number }>;

  // Search
  searchPosts(query: string, limit: number, offset: number): Promise<{
    posts: SearchedPost[];
    total: number;
  }>;

  // Token metadata
  getTokenMetadata(token: string): Promise<{
    name: string;
    symbol: string;
    decimals: number;
  } | null>;
}

export class PostgresDatabase implements Database {
  // In-memory caches for frequently-queryable records (BE-18).
  // Short TTL balances read performance with eventual consistency.
  //
  // Cache invalidation strategy (BE-33): Every successful write method that
  // mutates a cached entity deletes the corresponding cache entry after the
  // SQL statement completes. Failed writes preserve the valid cached value.
  // The TTL acts as a safety net for entries that were not explicitly invalidated.
  //
  // Cross-replica coordination (BA-026): a process-local cache alone can serve
  // stale records to a *different* indexer instance that shares the same
  // Postgres backend. To coordinate replicas we maintain a shared, monotonically
  // increasing `cache_epoch` in Postgres. Every writer bumps the epoch; each
  // cache entry records the epoch at insertion time; and a reader revalidates a
  // cache hit by comparing the entry's epoch against the latest shared epoch.
  // We poll the shared epoch with a short in-process window so reads stay cheap.
  //
  // Documented consistency bound: a mutation performed by another replica
  // becomes visible here no later than `sharedEpochRefreshMs` (poll window)
  // after it commits, and never after the entry TTL expires regardless of the
  // poll window — so stale reads are bounded even if polling is delayed.
  private readonly profileCache = new TTLCache<Profile>(30_000); // 30 seconds
  private readonly postCache = new TTLCache<Post>(30_000);

  private static readonly SHARED_EPOCH_REFRESH_MS = 500;
  private static readonly SHARED_EPOCH_KEY = "global";
  private sharedEpoch = 0;
  private sharedEpochFetchedAt = 0;
  private cacheCoordinationReady = false;
  private cacheCoordinationChecked = false;

  constructor(private readonly pool: Pool) {}

  /** Creates the shared `cache_epoch` table if it does not already exist. */
  private async ensureCacheCoordination(): Promise<void> {
    if (this.cacheCoordinationChecked) return;
    this.cacheCoordinationChecked = true;
    try {
      await this.runQuery(`
        CREATE TABLE IF NOT EXISTS cache_epoch (
          key TEXT PRIMARY KEY,
          epoch BIGINT NOT NULL
        )
      `);
      this.cacheCoordinationReady = true;
    } catch {
      // Table unavailable (e.g. missing DDL permission). Coordination degrades
      // to the documented TTL consistency bound, which the read path handles.
      this.cacheCoordinationReady = false;
    }
  }

  /** Returns the latest shared epoch, refreshing from Postgres at most every
   *  `SHARED_EPOCH_REFRESH_MS`. Falls back to the local snapshot on error. */
  private async readSharedEpoch(): Promise<number> {
    await this.ensureCacheCoordination();
    const now = Date.now();
    if (now - this.sharedEpochFetchedAt < PostgresDatabase.SHARED_EPOCH_REFRESH_MS) {
      return this.sharedEpoch;
    }
    if (this.cacheCoordinationReady) {
      try {
        const result = await this.runQuery(
          `SELECT COALESCE(MAX(epoch), 0)::BIGINT AS epoch FROM cache_epoch`
        );
        this.sharedEpoch = Number(result.rows[0]?.epoch ?? 0);
        this.sharedEpochFetchedAt = now;
      } catch {
        this.sharedEpochFetchedAt = now; // avoid hammering a failing table
      }
    } else {
      this.sharedEpochFetchedAt = now;
    }
    return this.sharedEpoch;
  }

  /** Bumps the shared epoch so every replica revalidates its cached entities. */
  private async bumpSharedEpoch(): Promise<void> {
    await this.ensureCacheCoordination();
    if (!this.cacheCoordinationReady) return;
    try {
      await this.runQuery(
        `INSERT INTO cache_epoch (key, epoch) VALUES ($1, 1)
         ON CONFLICT (key) DO UPDATE SET epoch = cache_epoch.epoch + 1`,
        [PostgresDatabase.SHARED_EPOCH_KEY]
      );
      // Reflect the bump immediately in the local snapshot.
      this.sharedEpoch += 1;
      this.sharedEpochFetchedAt = Date.now();
    } catch {
      // Best-effort; the TTL bound still protects correctness locally.
    }
  }

  /** Cached value is valid only if its epoch is not older than the shared one. */
  private async isCacheCurrent(entryEpoch: number): Promise<boolean> {
    if (entryEpoch === 0) return true; // entries recorded before coordination
    const shared = await this.readSharedEpoch();
    return entryEpoch >= shared;
  }

  /** Revalidates a raw cached entry against the shared epoch, returning its
   *  value only when it is still current. */
  private async revalidate<T>(entry: { value: T; epoch: number } | undefined) {
    if (!entry) return undefined;
    if (await this.isCacheCurrent(entry.epoch)) return entry.value;
    return undefined;
  }

  private async runQuery(queryText: string, params?: unknown[]) {
    return this.pool.query(queryText, params);
  }

  // BA-028: never convert lossy numeric values into bigints silently.
  // See the exported `toSafeBigInt` helper for the boundary rules.
  private toBigInt(value: unknown): bigint {
    return toSafeBigInt(value);
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
      deleted_ledger:
        row.deleted_ledger === null || row.deleted_ledger === undefined
          ? null
          : Number(row.deleted_ledger),
      created_at:
        row.created_at instanceof Date
          ? row.created_at
          : row.created_at
            ? new Date(String(row.created_at))
            : null,
      deleted_at:
        row.deleted_at instanceof Date
          ? row.deleted_at
          : row.deleted_at
            ? new Date(String(row.deleted_at))
            : null,
    };
  }

  async upsertProfile(profile: Profile): Promise<void> {
    await this.runQuery(
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
    // BA-026: tell every replica sharing this Postgres that caches changed.
    await this.bumpSharedEpoch();
    this.profileCache.delete(profile.address);
  }

  async getFollow(follower: string, followee: string): Promise<Follow | null> {
    const result = await this.runQuery(
      `SELECT follower, followee, ledger FROM follows WHERE follower = $1 AND followee = $2`,
      [follower, followee]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return {
      follower: String(row.follower),
      followee: String(row.followee),
      ledger: Number(row.ledger),
    };
  }

  async insertFollow(follow: Follow): Promise<void> {
    await this.runQuery(
      `
      INSERT INTO follows (follower, followee, ledger)
      VALUES ($1, $2, $3)
      ON CONFLICT (follower, followee) DO NOTHING
      `,
      [follow.follower, follow.followee, follow.ledger]
    );
  }

  async deleteFollow(follower: string, followee: string): Promise<void> {
    await this.runQuery(`DELETE FROM follows WHERE follower = $1 AND followee = $2`, [
      follower,
      followee,
    ]);
  }

  async insertPost(post: Post): Promise<void> {
    await this.runQuery(
      `
      INSERT INTO posts (id, author, content, tip_total, like_count, created_ledger, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))
      ON CONFLICT (id) DO NOTHING
      `,
      [
        post.id.toString(),
        post.author,
        post.content,
        post.tip_total.toString(),
        post.like_count.toString(),
        post.created_ledger,
        post.created_at ?? null,
      ]
    );
    await this.bumpSharedEpoch();
    this.postCache.delete(post.id.toString());
  }

  async markPostDeleted(post_id: bigint, deleted_ledger: number, deleted_at?: Date): Promise<void> {
    await this.runQuery(
      `
      UPDATE posts
      SET deleted_at = COALESCE($3, NOW()), deleted_ledger = $2
      WHERE id = $1 AND deleted_at IS NULL
      `,
      [post_id.toString(), deleted_ledger, deleted_at ?? null]
    );
    await this.bumpSharedEpoch();
    this.postCache.delete(post_id.toString());
  }

  async incrementPostLikeCount(post_id: bigint): Promise<void> {
    await this.runQuery(`UPDATE posts SET like_count = like_count + 1 WHERE id = $1`, [
      post_id.toString(),
    ]);
    await this.bumpSharedEpoch();
    this.postCache.delete(post_id.toString());
  }

  async addPostTipTotal(post_id: bigint, net_amount: bigint): Promise<void> {
    await this.runQuery(`UPDATE posts SET tip_total = tip_total + $2 WHERE id = $1`, [
      post_id.toString(),
      net_amount.toString(),
    ]);
    await this.bumpSharedEpoch();
    this.postCache.delete(post_id.toString());
  }

  async getPost(post_id: bigint): Promise<Post | null> {
    const key = post_id.toString();
    // Check cache first (BE-18), revalidating it against the shared epoch (BA-026).
    const cached = await this.revalidate(this.postCache.getEntry(key));
    if (cached) return cached;

    const result = await this.runQuery(`SELECT * FROM posts WHERE id = $1`, [key]);
    const post = result.rowCount ? this.mapPost(result.rows[0]) : null;

    // Cache for subsequent reads, tagged with the current shared epoch.
    if (post) this.postCache.set(key, post, await this.readSharedEpoch());
    return post;
  }

  async upsertLike(like: Like): Promise<boolean> {
    const result = await this.runQuery(
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
    await this.runQuery(
      `
      INSERT INTO tips (tipper, post_id, amount, fee, ledger, tx_hash)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tx_hash) DO NOTHING
      `,
      [
        tip.tipper,
        tip.post_id.toString(),
        tip.amount.toString(),
        tip.fee.toString(),
        tip.ledger,
        tip.tx_hash,
      ]
    );
  }

  async upsertPool(pool: PoolRecord): Promise<void> {
    await this.runQuery(
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
      [
        pool.pool_id,
        pool.token,
        pool.balance.toString(),
        pool.admins,
        pool.threshold,
        pool.created_ledger,
        pool.updated_ledger,
      ]
    );
  }

  async adjustPoolBalance(pool_id: string, delta: bigint, ledger: number): Promise<void> {
    await this.runQuery(
      `
      UPDATE pools
      SET balance = balance + $2, updated_ledger = $3
      WHERE pool_id = $1
      `,
      [pool_id, delta.toString(), ledger]
    );
  }

  async insertPool(pool: PoolRecord): Promise<void> {
    await this.runQuery(
      `
      INSERT INTO pools (pool_id, token, balance, admins, threshold, created_ledger, updated_ledger)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (pool_id) DO NOTHING
      `,
      [
        pool.pool_id,
        pool.token,
        pool.balance.toString(),
        pool.admins,
        pool.threshold,
        pool.created_ledger,
        pool.updated_ledger,
      ]
    );
  }

  async getPool(pool_id: string): Promise<PoolRecord | null> {
    const result = await this.runQuery(`SELECT * FROM pools WHERE pool_id = $1`, [pool_id]);
    return result.rowCount ? (result.rows[0] as PoolRecord) : null;
  }

  async listPools(filters: {
    limit: number;
    offset: number;
  }): Promise<{ pools: PoolRecord[]; total: number }> {
    const { limit, offset } = filters;
    const countResult = await this.runQuery(`SELECT COUNT(*)::int AS total FROM pools`);
    const result = await this.runQuery(
      `SELECT * FROM pools ORDER BY pool_id LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return {
      pools: result.rows.map((row) => ({
        pool_id: String(row.pool_id),
        token: String(row.token),
        balance: this.toBigInt(row.balance ?? 0),
        admins: Array.isArray(row.admins) ? row.admins : [],
        threshold: Number(row.threshold ?? 0),
        created_ledger: Number(row.created_ledger ?? 0),
        updated_ledger: Number(row.updated_ledger ?? 0),
      })),
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  }

  async getTokenMetadata(
    token: string
  ): Promise<{ name: string; symbol: string; decimals: number } | null> {
    try {
      const result = await this.runQuery(
        `SELECT name, symbol, decimals FROM token_metadata WHERE token_address = $1`,
        [token]
      );
      if (!result.rowCount) return null;
      const row = result.rows[0];
      return {
        name: String(row.name ?? "unknown"),
        symbol: String(row.symbol ?? "UNK"),
        decimals: Number(row.decimals ?? 7),
      };
    } catch {
      return null;
    }
  }

  async addPoolAdmin(pool_id: string, admin: string, ledger: number): Promise<void> {
    await this.runQuery(
      `
      UPDATE pools
      SET admins = array_append(admins, $2), updated_ledger = $3
      WHERE pool_id = $1 AND NOT (admins @> ARRAY[$2])
      `,
      [pool_id, admin, ledger]
    );
  }

  async removePoolAdmin(pool_id: string, admin: string, ledger: number): Promise<void> {
    await this.runQuery(
      `
      UPDATE pools
      SET admins = array_remove(admins, $2), updated_ledger = $3
      WHERE pool_id = $1
      `,
      [pool_id, admin, ledger]
    );
  }

  async getProfile(address: string): Promise<Profile | null> {
    // Check cache first (BE-18), revalidating it against the shared epoch (BA-026).
    const cached = await this.revalidate(this.profileCache.getEntry(address));
    if (cached) return cached;

    const result = await this.pool.query(`SELECT * FROM profiles WHERE address = $1`, [address]);
    const profile = result.rowCount ? (result.rows[0] as Profile) : null;

    // Cache for subsequent reads, tagged with the current shared epoch.
    if (profile) this.profileCache.set(address, profile, await this.readSharedEpoch());
    return profile;
  }

  async listProfiles(filters: {
    limit: number;
    offset: number;
  }): Promise<{ profiles: Profile[]; total: number }> {
    const { limit, offset } = filters;
    const countResult = await this.pool.query(`SELECT COUNT(*)::int AS total FROM profiles`);
    const result = await this.pool.query(
      `SELECT * FROM profiles ORDER BY address LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return {
      profiles: result.rows.map((row) => ({
        address: String(row.address),
        username: String(row.username),
        creator_token: String(row.creator_token),
        updated_ledger: Number(row.updated_ledger),
      })),
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  }

  async listPosts(filters: {
    author?: string;
    limit: number;
    offset: number;
  }): Promise<{ posts: Post[]; total: number }> {
    const { author, limit, offset } = filters;
    const values: unknown[] = [];
    let whereClause = "WHERE deleted_at IS NULL";

    if (author) {
      values.push(author);
      whereClause += ` AND author = $${values.length}`;
    }

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM posts ${whereClause}`,
      values
    );
    const result = await this.pool.query(
      `SELECT * FROM posts ${whereClause} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );

    return {
      posts: result.rows.map((row) => this.mapPost(row)),
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  }

  async searchPosts(filters: {
    query: string;
    limit: number;
    offset: number;
  }): Promise<{ posts: Post[]; total: number }> {
    const { query, limit, offset } = filters;
    const normalizedQuery = query.trim().replace(/\s+/g, " ");

    if (normalizedQuery === "") {
      return { posts: [], total: 0 };
    }

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

  async getFollowers(
    address: string,
    limit: number,
    offset: number
  ): Promise<{ followers: string[]; total: number }> {
    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM follows WHERE followee = $1`,
      [address]
    );
    const result = await this.pool.query(
      `SELECT follower FROM follows WHERE followee = $1 ORDER BY follower LIMIT $2 OFFSET $3`,
      [address, limit, offset]
    );

    return {
      followers: result.rows.map((row) => String(row.follower)),
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  }

  async getFollowing(
    address: string,
    limit: number,
    offset: number
  ): Promise<{ following: string[]; total: number }> {
    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM follows WHERE follower = $1`,
      [address]
    );
    const result = await this.pool.query(
      `SELECT followee FROM follows WHERE follower = $1 ORDER BY followee LIMIT $2 OFFSET $3`,
      [address, limit, offset]
    );

    return {
      following: result.rows.map((row) => String(row.followee)),
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  }

  async getFollowersAfter(
    address: string,
    cursor: string,
    limit: number
  ): Promise<{ followers: string[]; total: number }> {
    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM follows WHERE followee = $1`,
      [address]
    );
    const result = await this.pool.query(
      `SELECT follower FROM follows WHERE followee = $1 AND follower > $2 ORDER BY follower LIMIT $3`,
      [address, cursor, limit]
    );

    return {
      followers: result.rows.map((row) => String(row.follower)),
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  }

  async getFollowingAfter(
    address: string,
    cursor: string,
    limit: number
  ): Promise<{ following: string[]; total: number }> {
    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM follows WHERE follower = $1`,
      [address]
    );
    const result = await this.pool.query(
      `SELECT followee FROM follows WHERE follower = $1 AND followee > $2 ORDER BY followee LIMIT $3`,
      [address, cursor, limit]
    );

    return {
      following: result.rows.map((row) => String(row.followee)),
      total: Number(countResult.rows[0]?.total ?? 0),
    };
  }
}
