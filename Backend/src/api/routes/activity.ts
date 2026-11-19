import { Router, Request, Response } from "express";
import { PostgresActivityFeed } from "../../submissions/activity";
import { decodeCursor, encodeCursor } from "../../utils/cursor-pagination.utils";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  parseCursor,
  parseLimit,
  parseOffset,
  parseStellarAddress,
  sendValidationError,
  validate,
  type ValidationIssue,
} from "../validation";

const parseActivityLimit = parseLimit(MAX_LIMIT, DEFAULT_LIMIT);

export function createActivityRouter(feed: PostgresActivityFeed): Router {
  const router = Router();

  router.get("/:address", async (req: Request, res: Response): Promise<void> => {
    // The address and pagination are validated by the shared module so this
    // endpoint returns the same codes and envelope as every other public route
    // (issue #665) — previously a bad limit here produced `INVALID_PAGINATION`,
    // a code no other endpoint used.
    const parsed = validate<{ address: string; limit: number; offset: number; cursor?: string }>(
      {
        address: { parse: parseStellarAddress },
        limit: { parse: parseActivityLimit, required: false, default: DEFAULT_LIMIT },
        offset: { parse: parseOffset, required: false, default: 0 },
        cursor: { parse: parseCursor, required: false },
      },
      {
        address: req.params.address,
        limit: req.query.limit,
        offset: req.query.offset,
        cursor: req.query.cursor,
      }
    );
    if (!parsed.ok) {
      sendValidationError(res, parsed.issue);
      return;
    }

    const { address, limit } = parsed.value;
    let { offset } = parsed.value;

    if (parsed.value.cursor !== undefined) {
      try {
        const decoded = decodeCursor(parsed.value.cursor);
        const target = Number(decoded);
        if (!Number.isSafeInteger(target) || target < 0) {
          throw new Error("invalid cursor target");
        }
        offset = target;
      } catch {
        const issue: ValidationIssue = {
          status: 400,
          code: "INVALID_CURSOR",
          error: "cursor is malformed or tampered with",
          field: "cursor",
        };
        sendValidationError(res, issue);
        return;
      }
    }

    const page = await feed.list(address, limit, offset);
    // Only a real continuation gets a token; the final page omits the field
    // instead of returning an empty string clients might treat as valid.
    const response = page.hasMore
      ? { ...page, nextCursor: encodeCursor(String(offset + limit)) }
      : { ...page };
    res.json(response);
  });

  return router;
}
