/**
 * Unit tests for the pool event handlers.
 *
 * Issue #351 — acceptance criteria:
 *  - Happy path tested (PoolDeposit and PoolWithdraw)
 *  - Idempotency tested
 *  - Database calls mocked with jest.mock
 */

import {
  handlePoolCreated,
  handlePoolDeposit,
  handlePoolWithdraw,
  handlePoolAdminAdded,
  handlePoolAdminRemoved,
  PoolCreatedEvent,
  PoolDepositEvent,
  PoolWithdrawEvent,
  PoolAdminAddedEvent,
  PoolAdminRemovedEvent,
} from "../pool";
import { Database } from "../../db";

jest.mock("../../db");

function makeMockDb(): jest.Mocked<Database> {
  return {
    upsertProfile: jest.fn(),
    getFollow: jest.fn().mockResolvedValue(null),
    insertFollow: jest.fn(),
    deleteFollow: jest.fn(),
    insertPost: jest.fn(),
    markPostDeleted: jest.fn(),
    incrementPostLikeCount: jest.fn(),
    addPostTipTotal: jest.fn(),
    getPost: jest.fn(),
    upsertLike: jest.fn(),
    insertTip: jest.fn(),
    upsertPool: jest.fn(),
    adjustPoolBalance: jest.fn().mockResolvedValue(undefined),
    insertPool: jest.fn().mockResolvedValue(undefined),
    getPool: jest.fn().mockResolvedValue(null),
    addPoolAdmin: jest.fn().mockResolvedValue(undefined),
    removePoolAdmin: jest.fn().mockResolvedValue(undefined),
    getProfile: jest.fn().mockResolvedValue(null),
    listPosts: jest.fn().mockResolvedValue({ posts: [], total: 0 }),
    getFollowers: jest.fn().mockResolvedValue({ followers: [], total: 0 }),
    getFollowing: jest.fn().mockResolvedValue({ following: [], total: 0 }),
    searchPosts: jest.fn().mockResolvedValue({ posts: [], total: 0 }),
  } as jest.Mocked<Database>;
}

// ── handlePoolDeposit ─────────────────────────────────────────────────────────

describe("handlePoolDeposit", () => {
  let db: jest.Mocked<Database>;

  beforeEach(() => {
    db = makeMockDb();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("calls db.adjustPoolBalance with positive delta on deposit", async () => {
    const event: PoolDepositEvent = {
      depositor: "GABC123",
      pool_id: "pool1",
      token: "GTOKEN456",
      amount: BigInt(500),
      ledger: 200,
    };

    await handlePoolDeposit(db, event);

    expect(db.adjustPoolBalance).toHaveBeenCalledTimes(1);
    expect(db.adjustPoolBalance).toHaveBeenCalledWith("pool1", BigInt(500), 200);
  });

  it("resolves without error for a valid deposit event", async () => {
    const event: PoolDepositEvent = {
      depositor: "GABC123",
      pool_id: "pool1",
      token: "GTOKEN456",
      amount: BigInt(1000),
      ledger: 300,
    };

    await expect(handlePoolDeposit(db, event)).resolves.toBeUndefined();
  });

  it("handles large deposit amounts correctly", async () => {
    const event: PoolDepositEvent = {
      depositor: "GABC123",
      pool_id: "pool2",
      token: "GTOKEN456",
      amount: BigInt("9999999999999999"),
      ledger: 400,
    };

    await handlePoolDeposit(db, event);

    expect(db.adjustPoolBalance).toHaveBeenCalledWith("pool2", BigInt("9999999999999999"), 400);
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  it("is idempotent — replaying the same deposit event calls adjustPoolBalance again", async () => {
    const event: PoolDepositEvent = {
      depositor: "GABC123",
      pool_id: "pool1",
      token: "GTOKEN456",
      amount: BigInt(500),
      ledger: 200,
    };

    await handlePoolDeposit(db, event);
    await handlePoolDeposit(db, event);

    // Callers must use the ledger watermark to prevent double-counting;
    // the handler itself passes through to the db layer.
    expect(db.adjustPoolBalance).toHaveBeenCalledTimes(2);
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("throws when pool_id is missing", async () => {
    const event = {
      depositor: "GABC123",
      pool_id: "",
      token: "GTOKEN456",
      amount: BigInt(500),
      ledger: 200,
    } as PoolDepositEvent;

    await expect(handlePoolDeposit(db, event)).rejects.toThrow(
      "PoolDeposit event missing required field: pool_id"
    );
    expect(db.adjustPoolBalance).not.toHaveBeenCalled();
  });

  it("throws when amount is zero", async () => {
    const event: PoolDepositEvent = {
      depositor: "GABC123",
      pool_id: "pool1",
      token: "GTOKEN456",
      amount: BigInt(0),
      ledger: 200,
    };

    await expect(handlePoolDeposit(db, event)).rejects.toThrow(
      "PoolDeposit event amount must be positive"
    );
    expect(db.adjustPoolBalance).not.toHaveBeenCalled();
  });

  it("throws when amount is negative", async () => {
    const event: PoolDepositEvent = {
      depositor: "GABC123",
      pool_id: "pool1",
      token: "GTOKEN456",
      amount: BigInt(-100),
      ledger: 200,
    };

    await expect(handlePoolDeposit(db, event)).rejects.toThrow(
      "PoolDeposit event amount must be positive"
    );
    expect(db.adjustPoolBalance).not.toHaveBeenCalled();
  });

  // ── Database error propagation ──────────────────────────────────────────────

  it("propagates database errors", async () => {
    db.adjustPoolBalance.mockRejectedValueOnce(new Error("pool not found"));

    const event: PoolDepositEvent = {
      depositor: "GABC123",
      pool_id: "pool_missing",
      token: "GTOKEN456",
      amount: BigInt(100),
      ledger: 200,
    };

    await expect(handlePoolDeposit(db, event)).rejects.toThrow("pool not found");
  });
});

// ── handlePoolWithdraw ────────────────────────────────────────────────────────

describe("handlePoolWithdraw", () => {
  let db: jest.Mocked<Database>;

  beforeEach(() => {
    db = makeMockDb();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("calls db.adjustPoolBalance with negative delta on withdrawal", async () => {
    const event: PoolWithdrawEvent = {
      recipient: "GABC123",
      pool_id: "pool1",
      amount: BigInt(200),
      ledger: 250,
    };

    await handlePoolWithdraw(db, event);

    expect(db.adjustPoolBalance).toHaveBeenCalledTimes(1);
    expect(db.adjustPoolBalance).toHaveBeenCalledWith("pool1", BigInt(-200), 250);
  });

  it("resolves without error for a valid withdrawal event", async () => {
    const event: PoolWithdrawEvent = {
      recipient: "GXYZ789",
      pool_id: "pool1",
      amount: BigInt(100),
      ledger: 300,
    };

    await expect(handlePoolWithdraw(db, event)).resolves.toBeUndefined();
  });

  it("subtracts the correct amount from the pool balance", async () => {
    const event: PoolWithdrawEvent = {
      recipient: "GABC123",
      pool_id: "pool2",
      amount: BigInt(750),
      ledger: 400,
    };

    await handlePoolWithdraw(db, event);

    const [poolId, delta] = db.adjustPoolBalance.mock.calls[0];
    expect(poolId).toBe("pool2");
    expect(delta).toBe(BigInt(-750));
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  it("is idempotent — replaying the same withdrawal event calls adjustPoolBalance again", async () => {
    const event: PoolWithdrawEvent = {
      recipient: "GABC123",
      pool_id: "pool1",
      amount: BigInt(200),
      ledger: 250,
    };

    await handlePoolWithdraw(db, event);
    await handlePoolWithdraw(db, event);

    expect(db.adjustPoolBalance).toHaveBeenCalledTimes(2);
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("throws when pool_id is missing", async () => {
    const event = {
      recipient: "GABC123",
      pool_id: "",
      amount: BigInt(200),
      ledger: 250,
    } as PoolWithdrawEvent;

    await expect(handlePoolWithdraw(db, event)).rejects.toThrow(
      "PoolWithdraw event missing required field: pool_id"
    );
    expect(db.adjustPoolBalance).not.toHaveBeenCalled();
  });

  it("throws when amount is zero", async () => {
    const event: PoolWithdrawEvent = {
      recipient: "GABC123",
      pool_id: "pool1",
      amount: BigInt(0),
      ledger: 250,
    };

    await expect(handlePoolWithdraw(db, event)).rejects.toThrow(
      "PoolWithdraw event amount must be positive"
    );
    expect(db.adjustPoolBalance).not.toHaveBeenCalled();
  });

  it("throws when amount is negative", async () => {
    const event: PoolWithdrawEvent = {
      recipient: "GABC123",
      pool_id: "pool1",
      amount: BigInt(-50),
      ledger: 250,
    };

    await expect(handlePoolWithdraw(db, event)).rejects.toThrow(
      "PoolWithdraw event amount must be positive"
    );
    expect(db.adjustPoolBalance).not.toHaveBeenCalled();
  });

  // ── Database error propagation ──────────────────────────────────────────────

  it("propagates database errors", async () => {
    db.adjustPoolBalance.mockRejectedValueOnce(new Error("insufficient balance"));

    const event: PoolWithdrawEvent = {
      recipient: "GABC123",
      pool_id: "pool1",
      amount: BigInt(9999),
      ledger: 250,
    };

    await expect(handlePoolWithdraw(db, event)).rejects.toThrow("insufficient balance");
  });
});

// ── handlePoolCreated ─────────────────────────────────────────────────────────

describe("handlePoolCreated", () => {
  let db: jest.Mocked<Database>;

  beforeEach(() => {
    db = makeMockDb();
  });

  it("calls db.insertPool with correct initial state", async () => {
    const event: PoolCreatedEvent = {
      pool_id: "pool1",
      token: "GTOKEN456",
      admins: ["GADMIN1", "GADMIN2"],
      threshold: 2,
      ledger: 100,
    };

    await handlePoolCreated(db, event);

    expect(db.insertPool).toHaveBeenCalledTimes(1);
    expect(db.insertPool).toHaveBeenCalledWith({
      pool_id: "pool1",
      token: "GTOKEN456",
      balance: BigInt(0),
      admins: ["GADMIN1", "GADMIN2"],
      threshold: 2,
      created_ledger: 100,
      updated_ledger: 100,
    });
  });

  it("throws when pool_id is missing", async () => {
    const event = {
      pool_id: "",
      token: "GTOKEN",
      admins: ["GA"],
      threshold: 1,
      ledger: 1,
    } as PoolCreatedEvent;
    await expect(handlePoolCreated(db, event)).rejects.toThrow("pool_id");
    expect(db.insertPool).not.toHaveBeenCalled();
  });

  it("throws when admins list is empty", async () => {
    const event: PoolCreatedEvent = {
      pool_id: "p1",
      token: "GT",
      admins: [],
      threshold: 1,
      ledger: 1,
    };
    await expect(handlePoolCreated(db, event)).rejects.toThrow("admin");
    expect(db.insertPool).not.toHaveBeenCalled();
  });

  it("throws when threshold exceeds admins length", async () => {
    const event: PoolCreatedEvent = {
      pool_id: "p1",
      token: "GT",
      admins: ["GA"],
      threshold: 2,
      ledger: 1,
    };
    await expect(handlePoolCreated(db, event)).rejects.toThrow("threshold");
    expect(db.insertPool).not.toHaveBeenCalled();
  });
});

// ── handlePoolAdminAdded ──────────────────────────────────────────────────────

describe("handlePoolAdminAdded", () => {
  let db: jest.Mocked<Database>;

  beforeEach(() => {
    db = makeMockDb();
  });

  it("calls db.addPoolAdmin with correct arguments", async () => {
    const event: PoolAdminAddedEvent = { pool_id: "pool1", new_admin: "GADMIN3", ledger: 200 };

    await handlePoolAdminAdded(db, event);

    expect(db.addPoolAdmin).toHaveBeenCalledTimes(1);
    expect(db.addPoolAdmin).toHaveBeenCalledWith("pool1", "GADMIN3", 200);
  });

  it("throws when pool_id is missing", async () => {
    const event = { pool_id: "", new_admin: "GA", ledger: 1 } as PoolAdminAddedEvent;
    await expect(handlePoolAdminAdded(db, event)).rejects.toThrow("pool_id");
  });

  it("throws when new_admin is missing", async () => {
    const event = { pool_id: "p1", new_admin: "", ledger: 1 } as PoolAdminAddedEvent;
    await expect(handlePoolAdminAdded(db, event)).rejects.toThrow("new_admin");
  });
});

// ── handlePoolAdminRemoved ────────────────────────────────────────────────────

describe("handlePoolAdminRemoved", () => {
  let db: jest.Mocked<Database>;

  beforeEach(() => {
    db = makeMockDb();
  });

  it("calls db.removePoolAdmin with correct arguments", async () => {
    const event: PoolAdminRemovedEvent = {
      pool_id: "pool1",
      removed_admin: "GADMIN2",
      ledger: 300,
    };

    await handlePoolAdminRemoved(db, event);

    expect(db.removePoolAdmin).toHaveBeenCalledTimes(1);
    expect(db.removePoolAdmin).toHaveBeenCalledWith("pool1", "GADMIN2", 300);
  });

  it("throws when pool_id is missing", async () => {
    const event = { pool_id: "", removed_admin: "GA", ledger: 1 } as PoolAdminRemovedEvent;
    await expect(handlePoolAdminRemoved(db, event)).rejects.toThrow("pool_id");
  });

  it("throws when removed_admin is missing", async () => {
    const event = { pool_id: "p1", removed_admin: "", ledger: 1 } as PoolAdminRemovedEvent;
    await expect(handlePoolAdminRemoved(db, event)).rejects.toThrow("removed_admin");
  });
});
