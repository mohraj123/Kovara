import express from "express";
import request from "supertest";
import { createReconciliationRouter } from "../../reconciliation/routes";
import { ReconciliationQueryStore } from "../../reconciliation/stores";

function makeStore(overrides: Partial<ReconciliationQueryStore> = {}): ReconciliationQueryStore {
  return {
    listRuns: jest.fn(async () => ({ runs: [], total: 0 })),
    getRun: jest.fn(async () => null),
    ...overrides,
  };
}

function makeApp(store: ReconciliationQueryStore) {
  const app = express();
  app.use(express.json());
  app.use("/reconciliation", createReconciliationRouter(store));
  return app;
}

describe("reconciliation reporting API (#669)", () => {
  it("lists runs with pagination metadata", async () => {
    const store = makeStore({
      listRuns: jest.fn(async () => ({
        runs: [
          {
            runDate: "2026-09-25",
            status: "discrepancies" as const,
            sourceGroups: 4,
            aggregateGroups: 4,
            matchedGroups: 3,
            discrepancyCount: 1,
            error: null,
            startedAt: new Date(),
            completedAt: new Date(),
          },
        ],
        total: 1,
      })),
    });

    const res = await request(makeApp(store)).get("/reconciliation/runs");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.has_more).toBe(false);
    expect(res.body.runs[0].status).toBe("discrepancies");
  });

  it("returns an empty run list rather than a 404", async () => {
    const res = await request(makeApp(makeStore())).get("/reconciliation/runs");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ runs: [], total: 0, has_more: false });
  });

  it("returns one run with its discrepancies", async () => {
    const store = makeStore({
      getRun: jest.fn(async () => ({
        run: {
          runDate: "2026-09-25",
          status: "discrepancies" as const,
          sourceGroups: 1,
          aggregateGroups: 0,
          matchedGroups: 0,
          discrepancyCount: 1,
          error: null,
          startedAt: new Date(),
          completedAt: new Date(),
        },
        discrepancies: [
          {
            countryIso: "NG",
            category: "rent",
            kind: "missing_aggregate" as const,
            sourceCount: 3,
            aggregateCount: null,
            sourceValue: "300",
            aggregateValue: null,
            countDelta: null,
            valueDelta: null,
          },
        ],
      })),
    });

    const res = await request(makeApp(store)).get("/reconciliation/runs/2026-09-25");
    expect(res.status).toBe(200);
    expect(res.body.discrepancies).toHaveLength(1);
  });

  it("returns 404 for a run that does not exist", async () => {
    const res = await request(makeApp(makeStore())).get("/reconciliation/runs/2026-09-25");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a malformed date with 400 before querying", async () => {
    const store = makeStore();
    const res = await request(makeApp(store)).get("/reconciliation/runs/not-a-date");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_DATE" });
    expect(store.getRun).not.toHaveBeenCalled();
  });

  it("rejects an excessive limit", async () => {
    const res = await request(makeApp(makeStore())).get("/reconciliation/runs?limit=1000");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
});
