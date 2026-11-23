import http from "http";
import { AddressInfo } from "net";
import { createApp } from "../index";
import type { Database } from "../../db";

/**
 * HTTP-level checks for the moderation endpoints (issue #645).
 *
 * The store's transition rules are unit-tested in
 * `verification/__tests__/moderation.test.ts`; what matters here is that the
 * route layer maps them onto the right status codes — in particular that an
 * illegal transition is a 409 and not a 400, since a 400 tells the client its
 * request was malformed when in fact it was well-formed and simply not
 * currently allowed.
 */

const db = {
  getProfile: jest.fn().mockResolvedValue(null),
  listProfiles: jest.fn().mockResolvedValue({ profiles: [], total: 0 }),
  listPosts: jest.fn().mockResolvedValue({ posts: [], total: 0 }),
  listPools: jest.fn().mockResolvedValue({ pools: [], total: 0 }),
  searchPosts: jest.fn().mockResolvedValue({ posts: [], total: 0 }),
} as unknown as Database;

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = createApp(db);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${address.port}/api/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("moderation routes", () => {
  it("creates a case and returns it with 201", async () => {
    await withServer(async (base) => {
      const response = await post(base, "/moderation/cases", {
        subject: "submission",
        subjectId: "sub_1",
        reason: "price 40x the regional median",
        severity: "high",
        actor: "moderator-1",
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.case.status).toBe("open");
      expect(body.case.severity).toBe("high");
      expect(body.case.actions).toHaveLength(1);
    });
  });

  it("rejects an unknown subject with 400", async () => {
    await withServer(async (base) => {
      const response = await post(base, "/moderation/cases", {
        subject: "banana",
        subjectId: "sub_1",
        reason: "r",
        actor: "a",
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: "INVALID_SUBJECT" });
    });
  });

  it("returns 404 for an unknown case", async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/moderation/cases/mod_missing`);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ code: "CASE_NOT_FOUND" });
    });
  });

  it("walks a case open -> under_review -> resolved", async () => {
    await withServer(async (base) => {
      const opened = await post(base, "/moderation/cases", {
        subject: "vote",
        subjectId: "v_http",
        reason: "duplicate",
        actor: "a",
      });
      const { case: httpCase } = await opened.json();
      expect(httpCase.caseId).toBeTruthy();

      const review = await post(base, `/moderation/cases/${httpCase.caseId}/transitions`, {
        to: "under_review",
        actor: "lead",
        assignedTo: "reviewer-7",
      });
      expect(review.status).toBe(200);
      await expect(review.json()).resolves.toMatchObject({
        case: { status: "under_review", assignedTo: "reviewer-7" },
      });

      const resolved = await post(base, `/moderation/cases/${httpCase.caseId}/transitions`, {
        to: "resolved",
        actor: "lead",
      });
      const resolvedBody = await resolved.json();
      expect(resolvedBody.case.status).toBe("resolved");
      // The log must describe what happened, not a generic "assign".
      expect(resolvedBody.case.actions.map((a: { action: string }) => a.action)).toEqual([
        "request_review",
        "assign",
        "resolve",
      ]);
    });
  });

  it("answers 409 for a transition the current status does not allow", async () => {
    await withServer(async (base) => {
      const opened = await post(base, "/moderation/cases", {
        subject: "pool",
        subjectId: "pool_1",
        reason: "suspicious liquidity",
        actor: "a",
      });
      const { case: httpCase } = await opened.json();

      const response = await post(base, `/moderation/cases/${httpCase.caseId}/transitions`, {
        to: "resolved",
        actor: "lead",
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: "INVALID_TRANSITION" });
    });
  });

  it("requires an assignee when a case enters under_review", async () => {
    await withServer(async (base) => {
      const opened = await post(base, "/moderation/cases", {
        subject: "profile",
        subjectId: "p1",
        reason: "spam",
        actor: "a",
      });
      const { case: httpCase } = await opened.json();

      const response = await post(base, `/moderation/cases/${httpCase.caseId}/transitions`, {
        to: "under_review",
        actor: "lead",
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: "ASSIGNEE_REQUIRED" });
    });
  });

  it("moves the case as well as logging an escalation", async () => {
    await withServer(async (base) => {
      const opened = await post(base, "/moderation/cases", {
        subject: "submission",
        subjectId: "sub_9",
        reason: "outlier",
        actor: "a",
      });
      const { case: httpCase } = await opened.json();

      const response = await post(base, `/moderation/cases/${httpCase.caseId}/actions`, {
        action: "escalate",
        actor: "reviewer-7",
        note: "needs a second opinion",
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.case.status).toBe("escalated");
      expect(body.case.actions).toHaveLength(2);
    });
  });

  it("lists and filters cases", async () => {
    await withServer(async (base) => {
      await post(base, "/moderation/cases", {
        subject: "submission",
        subjectId: "sub_a",
        reason: "r",
        actor: "a",
      });
      await post(base, "/moderation/cases", {
        subject: "vote",
        subjectId: "vote_b",
        reason: "r",
        actor: "a",
      });

      const all = await fetch(`${base}/moderation/cases`);
      const allBody = await all.json();
      expect(allBody.total).toBe(2);

      const filtered = await fetch(`${base}/moderation/cases?subject=vote`);
      const filteredBody = await filtered.json();
      expect(filteredBody.total).toBe(1);
      expect(filteredBody.cases[0].subjectId).toBe("vote_b");
    });
  });

  it("rejects an unknown status filter", async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/moderation/cases?status=banished`);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: "INVALID_STATUS" });
    });
  });

  it("exposes a flattened action log for audit", async () => {
    await withServer(async (base) => {
      const opened = await post(base, "/moderation/cases", {
        subject: "submission",
        subjectId: "sub_z",
        reason: "r",
        actor: "a",
      });
      const { case: httpCase } = await opened.json();
      await post(base, `/moderation/cases/${httpCase.caseId}/actions`, {
        action: "comment",
        actor: "reviewer-7",
        note: "asked for a receipt",
      });

      const response = await fetch(`${base}/moderation/actions`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.total).toBe(2);
      // Not a positional check: the two writes can share a millisecond, and
      // their relative order is then decided by the tie-break, not by recency.
      expect(body.actions.map((a: { note: string }) => a.note)).toContain(
        "asked for a receipt"
      );
      for (const action of body.actions) {
        expect(action.caseId).toBe(httpCase.caseId);
      }
    });
  });

  it("rejects an out-of-range page window", async () => {
    await withServer(async (base) => {
      const cases = await fetch(`${base}/moderation/cases?limit=0`);
      expect(cases.status).toBe(400);

      const log = await fetch(`${base}/moderation/actions?limit=1000`);
      expect(log.status).toBe(400);
      await expect(log.json()).resolves.toMatchObject({ code: "INVALID_QUERY" });
    });
  });
});
