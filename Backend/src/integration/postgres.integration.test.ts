/**
 * BA-040: PostgreSQL integration coverage.
 *
 * These tests run against a real PostgreSQL instance (not a mock). They:
 *   1. run the full migration set (schema_version bookkeeping included),
 *   2. ingest representative raw events into the `events` table,
 *   3. insert representative API records (profiles, posts, likes, tips),
 *   4. query the resulting records through both the Database interface and the
 *      HTTP API, verifying schema/query compatibility.
 *
 * The suite is skipped automatically when `DATABASE_URL` is not set so the
 * regular (mock-heavy) unit test run on CI is unaffected.
 */
import { Pool } from "pg";
import request from "supertest";
import { runMigrations } from "../migrate";
import { PostgresDatabase, Profile, Post, Like, Tip } from "../db";
import { createApp } from "../api";

const DATABASE_URL = process.env["DATABASE_URL"];

/** A structurally valid 56-character Stellar (Ed25519, G-prefix) address. */
const STELLAR_ADDR =
  "GCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATCRU";

function describePg(name: string, fn: () => void): void {
  if (DATABASE_URL) {
    describe(name, fn);
  } else {
    describe.skip(name, fn);
  }
}

describePg("PostgreSQL integration", () => {
  let pool: Pool;
  let db: PostgresDatabase;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    pool = new Pool({ connectionString: DATABASE_URL! });

    // 1) Run the full migration set against the real database.
    await runMigrations(pool);

    db = new PostgresDatabase(pool);
    app = createApp(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("applies migrations and records them in schema_version", async () => {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS n FROM schema_version`
    );
    expect(Number(result.rows[0].n)).toBeGreaterThan(0);
  });

  it("ingests representative events into the events table", async () => {
    const event = {
      event_id: "evt-integration-0001",
      ledger: 100,
      contract_id: "CBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4T2",
      topic: ["Kovara::Post::Created"],
      value: "0x74657374",
      tx_hash: "txh-integration-0001",
      closed_at: new Date(),
    };

    await pool.query(
      `
      INSERT INTO events
        (event_id, ledger, contract_id, topic, value, tx_hash, closed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (event_id) DO NOTHING
      `,
      [
        event.event_id,
        event.ledger,
        event.contract_id,
        event.topic,
        event.value,
        event.tx_hash,
        event.closed_at,
      ]
    );

    const result = await pool.query(
      `SELECT topic, ledger FROM events WHERE event_id = $1`,
      [event.event_id]
    );
    expect(result.rowCount).toBe(1);
    expect(String(result.rows[0].ledger)).toBe("100");
    expect(Array.isArray(result.rows[0].topic)).toBe(true);
  });

  it("persists a representative profile and reads it back via the API", async () => {
    const profile: Profile = {
      address: STELLAR_ADDR,
      username: "integration_user",
      creator_token: "tkn-integration",
      updated_ledger: 10,
    };
    await db.upsertProfile(profile);

    const stored = await db.getProfile(profile.address);
    expect(stored?.username).toBe("integration_user");

    const res = await request(app).get(`/api/profiles/${profile.address}`);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe("integration_user");
  });

  it("persists a post with a large like count and preserves it in the API", async () => {
    const post: Post = {
      id: 9007199254740993n, // > Number.MAX_SAFE_INTEGER
      author: STELLAR_ADDR,
      content: "integration post body",
      deleted: false,
      tip_total: 0n,
      like_count: 9007199254740993n,
      created_ledger: 11,
      deleted_ledger: null,
    };
    await db.insertPost(post);

    const stored = await db.getPost(post.id);
    expect(stored?.like_count).toBe(9007199254740993n);

    const res = await request(app).get(`/api/posts/${post.id.toString()}`);
    expect(res.status).toBe(200);
    expect(res.body.like_count).toBe(post.like_count.toString());
    expect(res.body.tip_total).toBe("0");
  });

  it("persists likes and tips and reflects them in post aggregates", async () => {
    const postId = 9007199254740994n;
    await db.insertPost({
      id: postId,
      author: STELLAR_ADDR,
      content: "aggregate post",
      deleted: false,
      tip_total: 0n,
      like_count: 0n,
      created_ledger: 12,
      deleted_ledger: null,
    });

    const like: Like = { post_id: postId, user: STELLAR_ADDR, ledger: 13 };
    const inserted = await db.upsertLike(like);
    expect(inserted).toBe(true);

    const tip: Tip = {
      tipper: STELLAR_ADDR,
      post_id: postId,
      amount: 5000000n,
      fee: 1000000n,
      ledger: 14,
      tx_hash: "txh-tip-integration-0001",
    };
    await db.insertTip(tip);
    await db.addPostTipTotal(postId, tip.amount - tip.fee);

    const updated = await db.getPost(postId);
    expect(updated?.tip_total).toBe(4000000n);
  });
});
