/**
 * Fraud review and dispute handling (issue #645).
 *
 * Holds the moderation case lifecycle: who opened a case, what state it is in,
 * who moved it, and what they did. Three properties are enforced here rather
 * than at the route layer so they hold for every caller:
 *
 *  - **Transitions are validated.** A case cannot jump from `open` straight to
 *    `resolved`, and a closed case cannot be reopened. Without that, a typo in a
 *    status string silently discards a case's history.
 *  - **Every action is recorded**, and every recorded action says which case it
 *    belongs to — an audit entry nobody can attribute to a case is not evidence
 *    of anything.
 *  - **A recorded action never disagrees with the case's status.** Actions that
 *    imply a status change (`escalate`, `resolve`, `dismiss`) move the case, and
 *    are validated *before* anything is written. Logging an escalation against a
 *    case that was never escalated produces a record that lies.
 *
 * In-process storage, matching `verification-votes.ts` (#643), `regions.ts`
 * (#638) and `categories.ts` (#639). The case shape maps directly onto a table;
 * moving it into the `Database` layer is a storage swap, not a redesign.
 */

import { randomUUID } from "crypto";

export type ModerationStatus =
  | "open"
  | "under_review"
  | "escalated"
  | "resolved"
  | "dismissed";

/** Moderation operations that can be applied to a case. */
export type ModerationActionType =
  | "request_review"
  | "assign"
  | "request_evidence"
  | "warn_submitter"
  | "suspend_submitter"
  | "restore"
  | "escalate"
  | "resolve"
  | "dismiss"
  | "comment";

/** What the case is about. */
export type ModerationSubject = "submission" | "vote" | "profile" | "pool";

export type ModerationSeverity = "low" | "medium" | "high";

export interface ModerationAction {
  actionId: string;
  /** Which case this entry belongs to, so a flattened log stays attributable. */
  caseId: string;
  action: ModerationActionType;
  actor: string;
  note?: string;
  createdAt: string;
}

export interface ModerationCase {
  caseId: string;
  subject: ModerationSubject;
  subjectId: string;
  reason: string;
  status: ModerationStatus;
  /** Set when the case moves to `under_review`. */
  assignedTo: string | null;
  severity: ModerationSeverity;
  createdAt: string;
  updatedAt: string;
  actions: ModerationAction[];
}

/**
 * Allowed status transitions.
 *
 * `open` is the only entry point, and `resolved` / `dismissed` are terminal.
 * `escalated` is reachable from either review state because an escalation can
 * arrive late, and re-opening a closed case is deliberately absent: a fresh
 * concern should be a new case, which keeps the old one's history intact.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<ModerationStatus, readonly ModerationStatus[]>> =
  {
    open: ["under_review", "escalated", "dismissed"],
    under_review: ["escalated", "resolved", "dismissed"],
    escalated: ["under_review", "resolved", "dismissed"],
    resolved: [],
    dismissed: [],
  };

/**
 * Actions that imply a status change.
 *
 * Kept in one place so `transition` and `recordAction` cannot disagree about
 * what an action means. Everything absent from this table (`suspend_submitter`,
 * `request_evidence`, `comment`, …) acts on the *subject*, not on the case's
 * lifecycle, so it legitimately leaves the status alone.
 */
const STATUS_CHANGING_ACTIONS: Readonly<
  Partial<Record<ModerationActionType, ModerationStatus>>
> = {
  escalate: "escalated",
  resolve: "resolved",
  dismiss: "dismissed",
};

/** The log verb to record for a transition, e.g. `resolved` logs `resolve`. */
const TRANSITION_ACTIONS: Readonly<Record<ModerationStatus, ModerationActionType>> = {
  open: "assign",
  under_review: "assign",
  escalated: "escalate",
  resolved: "resolve",
  dismissed: "dismiss",
};

export class ModerationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ModerationError";
  }
}

export class UnknownCaseError extends ModerationError {
  constructor(caseId: string) {
    super(`Moderation case ${caseId} not found`, "CASE_NOT_FOUND", 404);
    this.name = "UnknownCaseError";
  }
}

export class InvalidTransitionError extends ModerationError {
  constructor(from: ModerationStatus, to: ModerationStatus) {
    super(
      `Cannot move a case from "${from}" to "${to}". ` +
        `Allowed: ${ALLOWED_TRANSITIONS[from].join(", ") || "(none - this state is terminal)"}`,
      "INVALID_TRANSITION",
      409
    );
    this.name = "InvalidTransitionError";
  }
}

export interface CreateCaseInput {
  subject: ModerationSubject;
  subjectId: string;
  reason: string;
  severity?: ModerationSeverity;
  actor: string;
  caseId?: string;
  now?: string;
}

/** Filters accepted by `ModerationStore.list`. */
export interface CaseFilters {
  status?: ModerationStatus;
  subject?: ModerationSubject;
  subjectId?: string;
  assignedTo?: string;
  limit?: number;
  offset?: number;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

const VALID_STATUSES = new Set<string>(Object.keys(ALLOWED_TRANSITIONS));
const VALID_ACTIONS = new Set<string>(Object.keys(STATUS_CHANGING_ACTIONS).concat([
  "request_review",
  "assign",
  "request_evidence",
  "warn_submitter",
  "suspend_submitter",
  "restore",
  "comment",
]));
const VALID_SUBJECTS = new Set<string>(["submission", "vote", "profile", "pool"]);
const VALID_SEVERITIES = new Set<string>(["low", "medium", "high"]);

/** Shared shape for a one-of-many string field, so each parser reads alike. */
function parseOneOf<T extends string>(
  value: unknown,
  valid: Set<string>,
  field: string
): T {
  if (typeof value !== "string" || !valid.has(value)) {
    throw new ModerationError(
      `${field} must be one of: ${[...valid].join(", ")}`,
      `INVALID_${field.toUpperCase()}`,
      400
    );
  }
  return value as T;
}

/** Validate a status string arriving from a request body or query. */
export function parseStatus(value: unknown): ModerationStatus {
  return parseOneOf<ModerationStatus>(value, VALID_STATUSES, "status");
}

export function parseAction(value: unknown): ModerationActionType {
  return parseOneOf<ModerationActionType>(value, VALID_ACTIONS, "action");
}

export function parseSubject(value: unknown): ModerationSubject {
  return parseOneOf<ModerationSubject>(value, VALID_SUBJECTS, "subject");
}

export function parseSeverity(value: unknown): ModerationSeverity {
  return parseOneOf<ModerationSeverity>(value, VALID_SEVERITIES, "severity");
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ModerationError(`${field} is required`, "INVALID_INPUT", 400);
  }
  return value.trim();
}

/**
 * Validate a page window.
 *
 * Shared by `list` and `actionLog` so that `?limit=100000` is rejected the same
 * way whichever collection is being paged.
 */
export function assertPagination(limit: number, offset: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ModerationError(
      `limit must be an integer between 1 and ${MAX_LIMIT}`,
      "INVALID_QUERY",
      400
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ModerationError("offset must be a non-negative integer", "INVALID_QUERY", 400);
  }
}

export class ModerationStore {
  private readonly cases = new Map<string, ModerationCase>();

  /** Open a case. The action log starts with the request itself. */
  create(input: CreateCaseInput): ModerationCase {
    const now = input.now ?? new Date().toISOString();
    const caseId = input.caseId ?? `mod_${randomUUID()}`;

    if (this.cases.has(caseId)) {
      throw new ModerationError(`Moderation case ${caseId} already exists`, "CASE_EXISTS", 409);
    }

    const subject = parseSubject(input.subject);
    const subjectId = requireText(input.subjectId, "subjectId");
    const reason = requireText(input.reason, "reason");
    const actor = requireText(input.actor, "actor");
    const severity = input.severity ? parseSeverity(input.severity) : "medium";

    const moderationCase: ModerationCase = {
      caseId,
      subject,
      subjectId,
      reason,
      status: "open",
      assignedTo: null,
      severity,
      createdAt: now,
      updatedAt: now,
      actions: [
        {
          actionId: `act_${randomUUID()}`,
          caseId,
          action: "request_review",
          actor,
          note: reason,
          createdAt: now,
        },
      ],
    };

    this.cases.set(caseId, moderationCase);
    return moderationCase;
  }

  get(caseId: string): ModerationCase {
    const moderationCase = this.cases.get(caseId);
    if (!moderationCase) throw new UnknownCaseError(caseId);
    return moderationCase;
  }

  /**
   * List cases newest-first with optional filters.
   *
   * Ordering is by `createdAt` then `caseId`. The tie-break on id matters: two
   * cases created in the same millisecond would otherwise come back in Map
   * insertion order, and pagination over an unstable order silently drops and
   * repeats rows across pages.
   */
  list(filters: CaseFilters = {}): { cases: ModerationCase[]; total: number } {
    const limit = filters.limit ?? DEFAULT_LIMIT;
    const offset = filters.offset ?? 0;
    assertPagination(limit, offset);

    const matched = [...this.cases.values()]
      .filter((c) => filters.status === undefined || c.status === filters.status)
      .filter((c) => filters.subject === undefined || c.subject === filters.subject)
      .filter((c) => filters.subjectId === undefined || c.subjectId === filters.subjectId)
      .filter((c) => filters.assignedTo === undefined || c.assignedTo === filters.assignedTo)
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
        return a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0;
      });

    return { cases: matched.slice(offset, offset + limit), total: matched.length };
  }

  /**
   * Move a case to a new status, appending the transition to its action log.
   *
   * `assignedTo` is required when a case enters `under_review`, because an
   * unassigned review is a review nobody is doing.
   */
  transition(
    caseId: string,
    to: ModerationStatus,
    actor: string,
    options: { note?: string; assignedTo?: string; now?: string } = {}
  ): ModerationCase {
    const moderationCase = this.get(caseId);

    // Checked before anything is written, so a rejected transition leaves the
    // case — and its log — exactly as they were.
    if (!ALLOWED_TRANSITIONS[moderationCase.status].includes(to)) {
      throw new InvalidTransitionError(moderationCase.status, to);
    }

    const now = options.now ?? new Date().toISOString();
    let assignedTo = moderationCase.assignedTo;

    if (to === "under_review" && !assignedTo && !options.assignedTo) {
      throw new ModerationError(
        "assignedTo is required to move a case to under_review",
        "ASSIGNEE_REQUIRED",
        400
      );
    }
    if (options.assignedTo) {
      assignedTo = requireText(options.assignedTo, "assignedTo");
    }

    const actingActor = requireText(actor, "actor");

    moderationCase.status = to;
    moderationCase.assignedTo = assignedTo;
    moderationCase.updatedAt = now;
    moderationCase.actions.push({
      actionId: `act_${randomUUID()}`,
      caseId,
      action: TRANSITION_ACTIONS[to],
      actor: actingActor,
      ...(options.note ? { note: options.note } : {}),
      createdAt: now,
    });

    return moderationCase;
  }

  /**
   * Record an action. Actions that imply a status change also move the case, so
   * the log and the case can never tell different stories.
   */
  recordAction(
    caseId: string,
    action: ModerationActionType,
    actor: string,
    options: { note?: string; now?: string } = {}
  ): ModerationCase {
    const moderationCase = this.get(caseId);
    const now = options.now ?? new Date().toISOString();
    const actingActor = requireText(actor, "actor");
    const implied = STATUS_CHANGING_ACTIONS[action];

    // Validate the implied status change *before* touching the log. Appending
    // first would leave an escalation entry recorded against a case that was
    // never actually escalated — an audit trail that lies about what happened.
    if (implied && moderationCase.status !== implied) {
      if (!ALLOWED_TRANSITIONS[moderationCase.status].includes(implied)) {
        throw new InvalidTransitionError(moderationCase.status, implied);
      }
    }

    moderationCase.actions.push({
      actionId: `act_${randomUUID()}`,
      caseId,
      action,
      actor: actingActor,
      ...(options.note ? { note: options.note } : {}),
      createdAt: now,
    });
    moderationCase.updatedAt = now;

    if (implied) {
      moderationCase.status = implied;
    }

    return moderationCase;
  }

  /** Flattened action history across cases, newest first — for audit review. */
  actionLog(limit = DEFAULT_LIMIT, offset = 0): { actions: ModerationAction[]; total: number } {
    assertPagination(limit, offset);

    const all = [...this.cases.values()]
      .flatMap((c) => c.actions)
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
        // Actions share a timestamp whenever one call writes several, so the
        // tie-break has to be stable. caseId is meaningful; the random actionId
        // is not, and ordering on it would shuffle equal rows between requests.
        if (a.caseId !== b.caseId) return a.caseId < b.caseId ? -1 : 1;
        return 0;
      });
    return { actions: all.slice(offset, offset + limit), total: all.length };
  }

  get size(): number {
    return this.cases.size;
  }
}
