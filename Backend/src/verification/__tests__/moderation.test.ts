import {
  ALLOWED_TRANSITIONS,
  assertPagination,
  InvalidTransitionError,
  ModerationError,
  ModerationStore,
  UnknownCaseError,
  parseAction,
  parseSeverity,
  parseStatus,
  parseSubject,
} from "../moderation";

function newStore(): ModerationStore {
  const store = new ModerationStore();
  store.create({
    subject: "submission",
    subjectId: "sub_1",
    reason: "price 40x the regional median",
    severity: "high",
    actor: "moderator-1",
    now: "2026-01-01T00:00:00Z",
  });
  return store;
}

function onlyCaseId(store: ModerationStore): string {
  return store.list().cases[0].caseId;
}

describe("create", () => {
  it("opens a case in `open` and logs the request as its first action", () => {
    const store = newStore();
    const moderationCase = store.get(onlyCaseId(store));

    expect(moderationCase.status).toBe("open");
    expect(moderationCase.assignedTo).toBeNull();
    expect(moderationCase.severity).toBe("high");
    expect(moderationCase.actions).toHaveLength(1);
    expect(moderationCase.actions[0].action).toBe("request_review");
    expect(moderationCase.actions[0].actor).toBe("moderator-1");
  });

  it("stamps every action with the case it belongs to", () => {
    // An audit entry that does not say which case it describes cannot be used
    // as evidence about that case.
    const store = newStore();
    const caseId = onlyCaseId(store);
    store.recordAction(caseId, "comment", "reviewer-7", { note: "asked for a receipt" });

    for (const action of store.get(caseId).actions) {
      expect(action.caseId).toBe(caseId);
    }
  });

  it("requires the identifying fields", () => {
    const store = new ModerationStore();

    expect(() =>
      store.create({ subject: "submission", subjectId: "  ", reason: "r", actor: "a" })
    ).toThrow(ModerationError);
    expect(() =>
      store.create({ subject: "submission", subjectId: "s", reason: "", actor: "a" })
    ).toThrow(ModerationError);
    expect(() =>
      store.create({ subject: "submission", subjectId: "s", reason: "r", actor: "" })
    ).toThrow(ModerationError);
  });

  it("leaves no case behind when a field is rejected", () => {
    const store = new ModerationStore();
    expect(() =>
      store.create({ subject: "submission", subjectId: "", reason: "r", actor: "a" })
    ).toThrow(ModerationError);

    expect(store.size).toBe(0);
  });

  it("rejects a duplicate case id", () => {
    const store = newStore();
    const caseId = onlyCaseId(store);

    expect(() =>
      store.create({ caseId, subject: "vote", subjectId: "v", reason: "r", actor: "a" })
    ).toThrow(/already exists/);
  });

  it("defaults severity to medium and rejects an unknown one", () => {
    const store = new ModerationStore();
    const created = store.create({ subject: "vote", subjectId: "v", reason: "r", actor: "a" });
    expect(created.severity).toBe("medium");

    expect(() =>
      store.create({
        subject: "vote",
        subjectId: "v2",
        reason: "r",
        actor: "a",
        severity: "catastrophic" as never,
      })
    ).toThrow(ModerationError);
  });

  it("rejects an unknown subject", () => {
    const store = new ModerationStore();
    expect(() =>
      store.create({ subject: "banana" as never, subjectId: "s", reason: "r", actor: "a" })
    ).toThrow(ModerationError);
  });
});

describe("transition", () => {
  it("moves open -> under_review and assigns an owner", () => {
    const store = newStore();
    const caseId = onlyCaseId(store);

    const updated = store.transition(caseId, "under_review", "lead", {
      assignedTo: "reviewer-7",
      now: "2026-01-02T00:00:00Z",
    });

    expect(updated.status).toBe("under_review");
    expect(updated.assignedTo).toBe("reviewer-7");
    expect(updated.actions).toHaveLength(2);
  });

  it("logs the verb that matches the transition, not a generic one", () => {
    // Logging "assign" against a resolved case would misdescribe the record:
    // nobody assigned anything, the case was closed.
    const store = newStore();
    const caseId = onlyCaseId(store);

    store.transition(caseId, "under_review", "lead", { assignedTo: "reviewer-7" });
    expect(store.get(caseId).actions.at(-1)?.action).toBe("assign");

    const resolved = store.transition(caseId, "resolved", "lead");
    expect(resolved.actions.at(-1)?.action).toBe("resolve");

    const other = newStore();
    const otherId = onlyCaseId(other);
    const dismissed = other.transition(otherId, "dismissed", "lead");
    expect(dismissed.actions.at(-1)?.action).toBe("dismiss");
  });

  it("refuses to move a case straight from open to resolved", () => {
    const store = newStore();
    const caseId = onlyCaseId(store);

    expect(() => store.transition(caseId, "resolved", "lead")).toThrow(InvalidTransitionError);
    expect(store.get(caseId).status).toBe("open");
  });

  it("leaves the log untouched when a transition is rejected", () => {
    const store = newStore();
    const caseId = onlyCaseId(store);
    const before = store.get(caseId).actions.length;

    expect(() => store.transition(caseId, "resolved", "lead")).toThrow(InvalidTransitionError);

    expect(store.get(caseId).actions).toHaveLength(before);
    expect(store.get(caseId).updatedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("treats resolved and dismissed as terminal", () => {
    expect(ALLOWED_TRANSITIONS.resolved).toEqual([]);
    expect(ALLOWED_TRANSITIONS.dismissed).toEqual([]);
  });

  it("refuses to reopen a closed case", () => {
    const store = newStore();
    const caseId = onlyCaseId(store);
    store.transition(caseId, "dismissed", "lead");

    expect(() => store.transition(caseId, "under_review", "lead")).toThrow(
      InvalidTransitionError
    );
  });

  it("requires an assignee when a case enters under_review", () => {
    // An unassigned review is a review nobody is doing.
    const store = newStore();
    const caseId = onlyCaseId(store);

    expect(() => store.transition(caseId, "under_review", "lead")).toThrow(/assignedTo/);
  });

  it("keeps an existing assignee when a case moves on", () => {
    const store = newStore();
    const caseId = onlyCaseId(store);
    store.transition(caseId, "under_review", "lead", { assignedTo: "reviewer-7" });

    const resolved = store.transition(caseId, "resolved", "lead");
    expect(resolved.assignedTo).toBe("reviewer-7");
  });

  it("allows escalation straight from open, because an escalation can arrive late", () => {
    const store = newStore();
    const updated = store.transition(onlyCaseId(store), "escalated", "lead");

    expect(updated.status).toBe("escalated");
    expect(updated.actions.at(-1)?.action).toBe("escalate");
  });

  it("404s an unknown case", () => {
    const store = new ModerationStore();
    expect(() => store.transition("nope", "resolved", "a")).toThrow(UnknownCaseError);
  });
});

describe("recordAction", () => {
  it("appends to the log without changing status", () => {
    const store = newStore();
    const caseId = onlyCaseId(store);

    const updated = store.recordAction(caseId, "request_evidence", "reviewer-7", {
      note: "need the source receipt",
    });

    expect(updated.status).toBe("open");
    expect(updated.actions).toHaveLength(2);
    expect(updated.actions[1].note).toBe("need the source receipt");
  });

  it("leaves the status alone for an action on the subject rather than the case", () => {
    // Suspending an account is not the same thing as moving the case, so the
    // case legitimately stays put.
    const store = newStore();
    const caseId = onlyCaseId(store);

    const updated = store.recordAction(caseId, "suspend_submitter", "reviewer-7");

    expect(updated.status).toBe("open");
    expect(updated.actions.at(-1)?.action).toBe("suspend_submitter");
  });

  it.each([
    ["escalate", "escalated"],
    ["resolve", "resolved"],
    ["dismiss", "dismissed"],
  ] as const)("moves the case as well when the action is %s", (action, expected) => {
    // Logging one of these without changing the status is how a case reads
    // `open` while everyone believes it was escalated.
    const store = newStore();
    const caseId = onlyCaseId(store);

    const updated = store.recordAction(caseId, action, "reviewer-7");

    expect(updated.status).toBe(expected);
  });

  it("refuses a status-changing action on a terminal case", () => {
    const store = newStore();
    const caseId = onlyCaseId(store);
    store.transition(caseId, "dismissed", "lead");

    expect(() => store.recordAction(caseId, "escalate", "reviewer-7")).toThrow(
      InvalidTransitionError
    );
    // The rejected escalation must leave no trace in the log, or the audit
    // trail records an escalation that never happened.
    expect(store.get(caseId).actions).toHaveLength(2);
    expect(store.get(caseId).status).toBe("dismissed");
  });

  it("allows re-recording an escalation on an already escalated case", () => {
    // Idempotent in the sense that matters: the action is appended, and the
    // status does not move backwards or throw.
    const store = newStore();
    const caseId = onlyCaseId(store);
    store.transition(caseId, "escalated", "lead");

    const updated = store.recordAction(caseId, "escalate", "reviewer-7", { note: "still stuck" });
    expect(updated.status).toBe("escalated");
  });
});

describe("list", () => {
  it("returns newest first", () => {
    const store = new ModerationStore();
    store.create({
      subject: "vote",
      subjectId: "old",
      reason: "r",
      actor: "a",
      now: "2026-01-01T00:00:00Z",
    });
    store.create({
      subject: "vote",
      subjectId: "new",
      reason: "r",
      actor: "a",
      now: "2026-02-01T00:00:00Z",
    });

    expect(store.list().cases.map((c) => c.subjectId)).toEqual(["new", "old"]);
  });

  it("breaks createdAt ties on caseId so pages cannot drop or repeat rows", () => {
    const store = new ModerationStore();
    // Same timestamp: without the tie-break these come back in insertion order.
    store.create({
      caseId: "mod_b",
      subject: "vote",
      subjectId: "b",
      reason: "r",
      actor: "a",
      now: "2026-01-01T00:00:00Z",
    });
    store.create({
      caseId: "mod_a",
      subject: "vote",
      subjectId: "a",
      reason: "r",
      actor: "a",
      now: "2026-01-01T00:00:00Z",
    });

    expect(store.list().cases.map((c) => c.caseId)).toEqual(["mod_a", "mod_b"]);
  });

  it("pages over a stable order without overlap", () => {
    const store = new ModerationStore();
    for (let i = 0; i < 5; i++) {
      store.create({ subject: "vote", subjectId: `v${i}`, reason: "r", actor: "a" });
    }

    const seen: string[] = [];
    for (let offset = 0; offset < 6; offset += 2) {
      seen.push(...store.list({ limit: 2, offset }).cases.map((c) => c.caseId));
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("filters by status, subject, subjectId and assignee", () => {
    const store = newStore();
    const caseId = onlyCaseId(store);
    store.transition(caseId, "under_review", "lead", { assignedTo: "reviewer-7" });
    store.create({ subject: "vote", subjectId: "vote_9", reason: "duplicate", actor: "a" });

    expect(store.list({ status: "under_review" }).total).toBe(1);
    expect(store.list({ subject: "vote" }).total).toBe(1);
    expect(store.list({ subjectId: "sub_1" }).total).toBe(1);
    expect(store.list({ assignedTo: "reviewer-7" }).total).toBe(1);
    expect(store.list({ assignedTo: "nobody" }).total).toBe(0);
  });

  it("rejects an out-of-range limit and a negative offset", () => {
    const store = newStore();
    expect(() => store.list({ limit: 0 })).toThrow(/limit/);
    expect(() => store.list({ limit: 1000 })).toThrow(/limit/);
    expect(() => store.list({ offset: -1 })).toThrow(/offset/);
  });
});

describe("actionLog", () => {
  it("flattens history across cases, newest first", () => {
    const store = newStore();
    const caseId = onlyCaseId(store);
    store.transition(caseId, "under_review", "lead", {
      assignedTo: "reviewer-7",
      now: "2026-01-05T00:00:00Z",
    });

    const log = store.actionLog();
    expect(log.total).toBe(2);
    expect(log.actions[0].createdAt).toBe("2026-01-05T00:00:00Z");
  });

  it("keeps every entry attributable to a case", () => {
    const store = newStore();
    store.create({ caseId: "mod_other", subject: "vote", subjectId: "v", reason: "r", actor: "a" });

    const log = store.actionLog();
    expect(new Set(log.actions.map((a) => a.caseId)).size).toBe(2);
  });

  it("is stable when several actions share a timestamp", () => {
    // Two writes in the same millisecond would otherwise be ordered by a random
    // uuid, so the audit view reshuffles between identical requests.
    const store = newStore();
    const caseId = onlyCaseId(store);
    const at = "2026-01-02T00:00:00Z";
    store.recordAction(caseId, "comment", "reviewer-7", { note: "first", now: at });
    store.recordAction(caseId, "comment", "reviewer-7", { note: "second", now: at });

    const first = store.actionLog().actions.map((a) => a.note);
    const second = store.actionLog().actions.map((a) => a.note);
    expect(first).toEqual(second);
  });

  it("pages the log the same way it pages cases", () => {
    const store = newStore();
    for (let i = 0; i < 4; i++) {
      store.recordAction(onlyCaseId(store), "comment", "reviewer-7");
    }

    const page = store.actionLog(2, 0);
    expect(page.actions).toHaveLength(2);
    expect(page.total).toBe(5);
  });

  it("rejects an out-of-range window", () => {
    const store = newStore();
    expect(() => store.actionLog(0)).toThrow(/limit/);
    expect(() => store.actionLog(10, -1)).toThrow(/offset/);
  });
});

describe("assertPagination", () => {
  it("accepts a sane window and rejects the rest", () => {
    expect(() => assertPagination(20, 0)).not.toThrow();
    expect(() => assertPagination(1, 0)).not.toThrow();
    expect(() => assertPagination(0, 0)).toThrow(/limit/);
    expect(() => assertPagination(101, 0)).toThrow(/limit/);
    expect(() => assertPagination(1.5, 0)).toThrow(/limit/);
    expect(() => assertPagination(NaN, 0)).toThrow(/limit/);
    expect(() => assertPagination(20, -1)).toThrow(/offset/);
  });
});

describe("parsers", () => {
  it("accepts known statuses and rejects unknown ones", () => {
    expect(parseStatus("open")).toBe("open");
    expect(parseStatus("escalated")).toBe("escalated");
    expect(() => parseStatus("banished")).toThrow(ModerationError);
    expect(() => parseStatus(7)).toThrow(ModerationError);
  });

  it("accepts known actions and rejects unknown ones", () => {
    expect(parseAction("suspend_submitter")).toBe("suspend_submitter");
    expect(parseAction("escalate")).toBe("escalate");
    expect(() => parseAction("delete_everything")).toThrow(ModerationError);
  });

  it("accepts known subjects and severities", () => {
    expect(parseSubject("pool")).toBe("pool");
    expect(() => parseSubject("banana")).toThrow(ModerationError);
    expect(parseSeverity("high")).toBe("high");
    expect(() => parseSeverity("urgent")).toThrow(ModerationError);
  });
});
