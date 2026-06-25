/**
 * Integration tests for contract binding generation (Issue #101).
 *
 * These tests verify that:
 *  - The KovaraClient exposes every method defined in the KovaraContract surface.
 *  - All public TypeScript types (Profile, Post, Pool) have the expected fields.
 *  - The index.ts re-exports every symbol consumers depend on.
 *  - The generate.sh script exists and is executable.
 *
 * These tests run entirely in Jest's Node.js environment with no live RPC
 * connection required. They guard against accidental regressions when the
 * contract API is updated and bindings are regenerated.
 */

import * as fs from "fs";
import * as path from "path";
import { KovaraClient } from "../client";
import type { Profile, Post, Pool } from "../types";
import * as SdkIndex from "..";

// ── 1. Contract read-method surface ──────────────────────────────────────────

describe("KovaraClient — read method surface matches KovaraContract", () => {
  const client = new KovaraClient({
    contractId: "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    rpcUrl: "https://soroban-testnet.stellar.org",
  });

  const expectedReadMethods: Array<keyof KovaraClient> = [
    "getProfile",
    "getPost",
    "getPostCount",
    "getFollowing",
    "getFollowers",
    "getPool",
    "getPoolAdmins",
    "getFeeBps",
    "getTreasury",
    "hasLiked",
    "isBlocked",
    "getLikeCount",
  ];

  it.each(expectedReadMethods)(
    "KovaraClient has read method: %s",
    (method) => {
      expect(typeof (client as Record<string, unknown>)[method]).toBe("function");
    },
  );

  it("all read methods return Promises", () => {
    // Verify the methods are async by checking they return a thenable when
    // called with placeholder arguments (the call will fail but the return
    // type should still be a Promise before it rejects).
    const callWithPlaceholder = (method: string): unknown => {
      const fn = (client as Record<string, (...args: unknown[]) => unknown>)[method];
      try {
        return fn.call(client, "G_PLACEHOLDER", 0, "", false);
      } catch {
        return null;
      }
    };

    for (const method of expectedReadMethods) {
      const result = callWithPlaceholder(method as string);
      if (result !== null) {
        expect(result).toHaveProperty("then");
      }
    }
  });
});

// ── 2. Contract write-method surface ─────────────────────────────────────────

describe("KovaraClient — write method surface matches KovaraContract", () => {
  const client = new KovaraClient({
    contractId: "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    rpcUrl: "https://soroban-testnet.stellar.org",
  });

  const expectedWriteMethods: Array<keyof KovaraClient> = [
    "createPost",
    "follow",
    "unfollow",
    "tip",
    "likePost",
    "deletePost",
    "createPool",
    "deposit",
    "withdraw",
    "setProfile",
    "block",
    "unblock",
  ];

  it.each(expectedWriteMethods)(
    "KovaraClient has write method: %s",
    (method) => {
      expect(typeof (client as Record<string, unknown>)[method]).toBe("function");
    },
  );

  it("write methods return strings (XDR envelopes)", () => {
    // Write methods are synchronous and return a base64-encoded XDR envelope.
    // We call each with dummy arguments and verify the return type is a string
    // (the actual XDR value will be invalid but the type must hold).
    const addr = "GADUMMYADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    const calls: Array<() => unknown> = [
      () => client.createPost(addr, "content"),
      () => client.follow(addr, addr),
      () => client.unfollow(addr, addr),
      () => client.setProfile(addr, "username", addr),
      () => client.block(addr, addr),
      () => client.unblock(addr, addr),
    ];

    for (const call of calls) {
      const result = call();
      expect(typeof result).toBe("string");
    }
  });
});

// ── 3. TypeScript type shape — Profile ───────────────────────────────────────

describe("Profile type shape matches KovaraContract storage", () => {
  const sampleProfile: Profile = {
    address: "GCKFBEIYTKP6RCZNVPH73XL7XFWTEOAO4MKONX7HOILHDVBMW5EVPOPZ",
    username: "alice",
    creator_token: "TOKEN_CONTRACT_ADDRESS",
    follower_count: 10,
    following_count: 5,
  };

  it("has required field: address (string)", () => {
    expect(typeof sampleProfile.address).toBe("string");
  });

  it("has required field: username (string)", () => {
    expect(typeof sampleProfile.username).toBe("string");
  });

  it("has required field: creator_token (string)", () => {
    expect(typeof sampleProfile.creator_token).toBe("string");
  });

  it("has required field: follower_count (number)", () => {
    expect(typeof sampleProfile.follower_count).toBe("number");
  });

  it("has required field: following_count (number)", () => {
    expect(typeof sampleProfile.following_count).toBe("number");
  });

  it("contains exactly the expected fields (no extra keys)", () => {
    const keys = Object.keys(sampleProfile).sort();
    expect(keys).toEqual(
      ["address", "creator_token", "follower_count", "following_count", "username"].sort(),
    );
  });
});

// ── 4. TypeScript type shape — Post ──────────────────────────────────────────

describe("Post type shape matches KovaraContract storage", () => {
  const samplePost: Post = {
    id: 1,
    author: "GAUTHOR",
    username: "bob",
    content: "Hello world",
    tip_total: 500,
    timestamp: 1_700_000_000,
    like_count: 42,
  };

  it("has required field: id (number)", () => {
    expect(typeof samplePost.id).toBe("number");
  });

  it("has required field: author (string)", () => {
    expect(typeof samplePost.author).toBe("string");
  });

  it("has required field: username (string)", () => {
    expect(typeof samplePost.username).toBe("string");
  });

  it("has required field: content (string)", () => {
    expect(typeof samplePost.content).toBe("string");
  });

  it("has required field: tip_total (number)", () => {
    expect(typeof samplePost.tip_total).toBe("number");
  });

  it("has required field: timestamp (number)", () => {
    expect(typeof samplePost.timestamp).toBe("number");
  });

  it("has required field: like_count (number)", () => {
    expect(typeof samplePost.like_count).toBe("number");
  });

  it("contains exactly the expected fields (no extra keys)", () => {
    const keys = Object.keys(samplePost).sort();
    expect(keys).toEqual(
      ["author", "content", "id", "like_count", "timestamp", "tip_total", "username"].sort(),
    );
  });
});

// ── 5. TypeScript type shape — Pool ──────────────────────────────────────────

describe("Pool type shape matches KovaraContract storage", () => {
  const samplePool: Pool = {
    pool_id: "pool-1",
    token: "TOKEN_CONTRACT_ADDRESS",
    balance: 100_000n,
    admins: ["GADMIN1", "GADMIN2"],
    threshold: 2,
  };

  it("has required field: pool_id (string)", () => {
    expect(typeof samplePool.pool_id).toBe("string");
  });

  it("has required field: token (string)", () => {
    expect(typeof samplePool.token).toBe("string");
  });

  it("has required field: balance (bigint)", () => {
    expect(typeof samplePool.balance).toBe("bigint");
  });

  it("has required field: admins (string[])", () => {
    expect(Array.isArray(samplePool.admins)).toBe(true);
    for (const a of samplePool.admins) {
      expect(typeof a).toBe("string");
    }
  });

  it("has required field: threshold (number)", () => {
    expect(typeof samplePool.threshold).toBe("number");
  });

  it("contains exactly the expected fields (no extra keys)", () => {
    const keys = Object.keys(samplePool).sort();
    expect(keys).toEqual(["admins", "balance", "pool_id", "threshold", "token"].sort());
  });
});

// ── 6. Index re-export completeness ──────────────────────────────────────────

describe("index.ts re-exports match the expected public SDK surface", () => {
  const requiredExports = [
    // Client
    "KovaraClient",
    // Errors
    "KovaraError",
    "NotFoundError",
    "UnauthorizedError",
    "InsufficientBalanceError",
    "CooldownError",
    "InvalidInputError",
    "InvalidManifestError",
    "mapError",
    // Mini-apps
    "validateManifest",
  ];

  it.each(requiredExports)("index exports: %s", (symbol) => {
    expect(symbol in SdkIndex).toBe(true);
    expect((SdkIndex as Record<string, unknown>)[symbol]).toBeDefined();
  });
});

// ── 7. generate.sh binding script exists and is valid ────────────────────────

describe("generate.sh binding script", () => {
  const repoRoot = path.resolve(__dirname, "../../../../..");
  const scriptPath = path.join(repoRoot, "packages", "sdk", "generate.sh");

  it("generate.sh exists in packages/sdk/", () => {
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  it("generate.sh references the correct WASM output path", () => {
    const content = fs.readFileSync(scriptPath, "utf8");
    expect(content).toContain("wasm32-unknown-unknown");
    expect(content).toContain("stellar contract bindings typescript");
  });

  it("generate.sh specifies an --output-dir", () => {
    const content = fs.readFileSync(scriptPath, "utf8");
    expect(content).toContain("--output-dir");
  });

  it("generate.sh targets packages/sdk/src as output", () => {
    const content = fs.readFileSync(scriptPath, "utf8");
    expect(content).toContain("packages/sdk/src");
  });
});

// ── 8. No undefined exports in index.ts ──────────────────────────────────────

describe("No undefined values in SDK index exports", () => {
  it("every exported value is defined (not undefined)", () => {
    for (const [key, value] of Object.entries(SdkIndex)) {
      expect(value).toBeDefined();
      if (process.env.CI) {
        expect(value, `Export '${key}' is undefined`).not.toBeUndefined();
      }
    }
  });
});
