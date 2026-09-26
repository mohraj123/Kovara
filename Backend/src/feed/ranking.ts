/**
 * Feed ranking and trending (#676).
 *
 * A feed that returns posts in insertion order answers "what is new", never
 * "what matters". This module supplies the ranking rules, and the whole of it
 * is **pure and explainable**: the same candidates and the same clock always
 * produce the same order, and every ranked entry carries the signals that
 * produced its score. That is deliberate — a ranking nobody can explain is a
 * ranking nobody can debug when it surfaces the wrong thing.
 *
 * Three modes, and each answers a different question:
 *
 *   - **ranked** — the default front page. Engagement (likes + tips, log
 *     scaled) plus recency, combined with fixed weights. A post with 10 000
 *     likes should not permanently swamp a better, newer post, and a brand-new
 *     post with no engagement should not outrank a highly-engaged one from
 *     yesterday, so neither signal dominates.
 *   - **recent** — strict reverse-chronological. A client that wants "newest
 *     first" gets exactly that, with no scoring at all.
 *   - **trending** — engagement *rate*, not raw engagement, over a bounded
 *     window. A post with a decade of accumulated likes is not trending; a post
 *     that earned its likes in the last few days is. The window is explicit
 *     and reported back, so "trending" is a defined quantity rather than a
 *     vibe.
 *
 * Every ordering ends with `id` descending. Without a unique trailing key, two
 * entries with the same score can swap between identical requests and a client
 * paging through the feed sees a row twice and misses another.
 */

/** A post as the feed reads it. */
export interface FeedCandidate {
  id: bigint;
  author: string;
  content: string;
  tip_total: bigint;
  like_count: bigint;
  created_ledger: number;
  created_at?: Date | null;
  deleted_at?: Date | null;
}

/** How the feed is ordered. */
export type FeedMode = "ranked" | "recent" | "trending";

export const FEED_MODES: FeedMode[] = ["ranked", "recent", "trending"];

/** Weights for the `ranked` mode. Exposed so relevance can be tuned. */
export interface FeedWeights {
  /** Likes and tips. */
  engagement: number;
  /** How recent the post is. */
  recency: number;
}

export const DEFAULT_FEED_WEIGHTS: FeedWeights = {
  engagement: 0.6,
  recency: 0.4,
};

/** Default trending window, in days. */
export const DEFAULT_TRENDING_WINDOW_DAYS = 7;

/**
 * Trending gravity. A value of 1 divides engagement by age in days; higher
 * values punish age harder. `1.5` is the common "Hacker News"-style choice:
 * it lets a genuinely popular recent post beat a slightly more popular older
 * one, without letting a day-old post win on age alone.
 */
export const DEFAULT_TRENDING_GRAVITY = 1.5;

/** The signals behind one entry's score, so the order is explainable. */
export interface FeedSignals {
  /** Log-scaled like + tip total, in [0, 1]. */
  engagement: number;
  /** Recency, in [0, 1]; 1 is now, decaying with age. */
  recency: number;
  /** Age in hours at the time the feed was computed, or null if unknown. */
  age_hours: number | null;
}

/** One ranked feed entry. */
export interface FeedEntry {
  id: string;
  author: string;
  content: string;
  tip_total: string;
  like_count: string;
  created_at: string | null;
  /** The entry's final score; comparable only within one response. */
  score: number;
  /** Whether the post has been soft-deleted. */
  deleted: boolean;
  signals: FeedSignals;
}

/** Options for a single feed computation. */
export interface FeedOptions {
  mode: FeedMode;
  limit: number;
  offset: number;
  /** Injectable clock, for tests and reproducible ordering. */
  now?: Date;
  weights?: FeedWeights;
  /** Trending window in days. Ignored outside `trending` mode. */
  trendingWindowDays?: number;
}

/** A computed page of the feed, plus the rules that produced it. */
export interface FeedResult {
  mode: FeedMode;
  entries: FeedEntry[];
  /** Number of candidates considered before pagination. */
  candidate_count: number;
  limit: number;
  offset: number;
  has_more: boolean;
  /** The ruleset, echoed so a client can display why the order is what it is. */
  ranking: {
    weights: FeedWeights;
    trending_window_days: number | null;
    trending_gravity: number | null;
  };
}

/** Longest accepted feed page. Bounds the work one request can cause. */
export const MAX_FEED_LIMIT = 100;

const MS_PER_HOUR = 3_600_000;

/**
 * Validate a raw `mode`, defaulting to `"ranked"` when absent.
 *
 * An unrecognised mode is a 400 rather than silently falling back to the
 * default: a client that typo'd `trending` and received a chronological feed
 * would have no way to notice.
 */
export function validateFeedMode(raw: unknown): FeedMode {
  if (raw === undefined || raw === null || raw === "") return "ranked";
  if (typeof raw === "string" && (FEED_MODES as string[]).includes(raw)) {
    return raw as FeedMode;
  }
  throw new FeedValidationError(
    `mode must be one of: ${FEED_MODES.join(", ")}`,
    "INVALID_MODE"
  );
}

/** Raised for input the caller can correct. The route maps it to 400. */
export class FeedValidationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "FeedValidationError";
    this.code = code;
  }
}

/** Parse and validate `limit`, defaulting to 20. */
export function parseFeedLimit(raw: unknown, defaultValue = 20): number {
  const value = raw === undefined || raw === null || raw === "" ? defaultValue : Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new FeedValidationError("limit must be a positive integer", "INVALID_QUERY");
  }
  if (value > MAX_FEED_LIMIT) {
    throw new FeedValidationError(`limit cannot exceed ${MAX_FEED_LIMIT}`, "LIMIT_EXCEEDED");
  }
  return value;
}

/** Parse and validate `offset`, defaulting to 0. */
export function parseFeedOffset(raw: unknown, defaultValue = 0): number {
  const value = raw === undefined || raw === null || raw === "" ? defaultValue : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new FeedValidationError("offset must be a non-negative integer", "INVALID_QUERY");
  }
  return value;
}

/**
 * Log-scaled engagement in [0, 1].
 *
 * `ln(1 + x)` is used rather than the raw count: engagement spans many orders
 * of magnitude, and a linear scale would let a single viral post define the
 * feed forever. The result is normalised against a reference count so it
 * saturates, meaning the thousandth like matters far less than the tenth —
 * which is what "engagement" actually means to a reader.
 */
export function engagementScore(post: Pick<FeedCandidate, "like_count" | "tip_total">): number {
  const raw = Number(post.like_count ?? 0n) + Number(post.tip_total ?? 0n);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  // ln(1 + 10 000) ≈ 9.21; normalising by that puts a very popular post near 1.
  return clamp01(Math.log1p(raw) / Math.log1p(10_000));
}

/**
 * Linear recency decay in [0, 1] over `halfLifeDays`.
 *
 * A post at the half-life scores 0.5; one twice the half-life scores 0. A post
 * with no known timestamp scores 0 — it cannot be shown to be recent, and
 * inventing a timestamp from a ledger number would make the order depend on an
 * assumption.
 */
export function recencyScore(
  createdAt: Date | null | undefined,
  now: Date,
  halfLifeDays = 30
): number {
  const age = ageInHours(createdAt, now);
  if (age === null) return 0;
  const halfLifeHours = halfLifeDays * 24;
  return clamp01(1 - age / (2 * halfLifeHours));
}

/** Age in hours, or null when the timestamp is absent or unparseable. */
export function ageInHours(createdAt: Date | null | undefined, now: Date): number | null {
  if (!createdAt) return null;
  const time = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, (now.getTime() - time) / MS_PER_HOUR);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Round a score to 6 places so JSON output is stable across platforms. */
function roundScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Compute the feed.
 *
 * Deleted posts are dropped before ranking — a soft-deleted post is not part of
 * the feed regardless of how engaged it once was. The remaining candidates are
 * scored, sorted with a total order, then sliced to the requested page.
 */
export function rankFeed(candidates: FeedCandidate[], options: FeedOptions): FeedResult {
  const {
    mode,
    limit,
    offset,
    now = new Date(),
    weights = DEFAULT_FEED_WEIGHTS,
    trendingWindowDays = DEFAULT_TRENDING_WINDOW_DAYS,
  } = options;

  const visible = candidates.filter((post) => !isDeleted(post));

  // Trending is defined *within* the window: a post older than it is not part
  // of the trending feed at all, rather than merely ranked last. Keeping it in
  // the list would make `total` count posts that can never be shown.
  const eligible =
    mode === "trending"
      ? visible.filter((post) => {
          const age = ageInHours(post.created_at, now);
          return age !== null && age <= trendingWindowDays * 24;
        })
      : visible;

  const scored = eligible.map((post) => scoreEntry(post, { mode, now, weights, trendingWindowDays }));

  scored.sort(compareEntries(mode));

  const page = scored.slice(offset, offset + limit);

  return {
    mode,
    entries: page,
    candidate_count: eligible.length,
    limit,
    offset,
    has_more: offset + page.length < eligible.length,
    ranking: {
      weights,
      trending_window_days: mode === "trending" ? trendingWindowDays : null,
      trending_gravity: mode === "trending" ? DEFAULT_TRENDING_GRAVITY : null,
    },
  };
}

function isDeleted(post: FeedCandidate): boolean {
  return post.deleted_at !== undefined && post.deleted_at !== null;
}

/** Score one post for one mode. */
function scoreEntry(
  post: FeedCandidate,
  ctx: { mode: FeedMode; now: Date; weights: FeedWeights; trendingWindowDays: number }
): FeedEntry {
  const age = ageInHours(post.created_at, ctx.now);
  const engagement = engagementScore(post);
  const recency = recencyScore(post.created_at, ctx.now);

  let score: number;
  if (ctx.mode === "recent") {
    // Reverse-chronological: the timestamp is the score. Missing timestamps
    // sort last rather than first, since they cannot be shown to be new.
    score = age === null ? Number.NEGATIVE_INFINITY : -age;
  } else if (ctx.mode === "trending") {
    score = trendingScore(post, ctx.now, ctx.trendingWindowDays);
  } else {
    score = ctx.weights.engagement * engagement + ctx.weights.recency * recency;
  }

  return {
    id: post.id.toString(),
    author: post.author,
    content: post.content,
    tip_total: (post.tip_total ?? 0n).toString(),
    like_count: (post.like_count ?? 0n).toString(),
    created_at:
      post.created_at instanceof Date
        ? post.created_at.toISOString()
        : post.created_at
          ? new Date(post.created_at).toISOString()
          : null,
    score: roundScore(score),
    deleted: false,
    signals: {
      engagement: roundScore(engagement),
      recency: roundScore(recency),
      age_hours: age === null ? null : roundScore(age),
    },
  };
}

/**
 * Trending score: engagement divided by age, raised by a gravity exponent.
 *
 * Engagement is `(likes + tips + 1)` so a zero-engagement post does not divide
 * to zero and tie with every other zero-engagement post; the `+1` keeps the
 * ordering meaningful. Posts outside the window score `-Infinity` so they drop
 * to the bottom rather than being silently included.
 */
function trendingScore(post: FeedCandidate, now: Date, windowDays: number): number {
  const age = ageInHours(post.created_at, now);
  if (age === null) return Number.NEGATIVE_INFINITY;
  if (age > windowDays * 24) return Number.NEGATIVE_INFINITY;

  const raw = Number(post.like_count ?? 0n) + Number(post.tip_total ?? 0n) + 1;
  const ageDays = Math.max(age / 24, 1 / 24); // floor at one hour so "now" is finite
  return raw / Math.pow(ageDays, DEFAULT_TRENDING_GRAVITY);
}

/**
 * Total order for the scored entries.
 *
 * Score descending, then `id` descending. `id` is unique and monotonic, so the
 * order is *total* and identical requests return identical pages. For `recent`
 * the score is already `-age`, so this also yields newest-first.
 */
function compareEntries(mode: FeedMode): (a: FeedEntry, b: FeedEntry) => number {
  return (a, b) => {
    if (b.score !== a.score) {
      // `-Infinity` entries sort last regardless of sign conventions.
      if (!Number.isFinite(a.score) && !Number.isFinite(b.score)) return compareId(b, a);
      if (!Number.isFinite(a.score)) return 1;
      if (!Number.isFinite(b.score)) return -1;
      return b.score - a.score;
    }
    void mode;
    return compareId(b, a);
  };
}

function compareId(a: FeedEntry, b: FeedEntry): number {
  return BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
}
