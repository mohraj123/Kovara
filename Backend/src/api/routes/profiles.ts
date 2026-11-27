import { Router, Request, Response } from "express";
import { Database, Profile } from "../../db";
import { ApiErrorResponse, ProfileResponse } from "../contracts";
import {
  isStellarAddress,
  parseStellarAddress,
  parseOptionalStellarAddress,
  parseUsername,
  sendValidationError,
  ValidationResult,
} from "../validation";

/**
 * Validates that the given string is a well-formed Stellar public key.
 *
 * Kept as a named export for existing callers, but delegates to the shared
 * validator (issue #665) so this endpoint cannot drift from the rest of the
 * API: Stellar strkeys use the base-32 alphabet `A–Z`, `2–7`, not `[A-Z0-9]`.
 */
export function isValidStellarAddress(addr: string): boolean {
  return isStellarAddress(addr);
}

/**
 * Serialize a stored profile to its API shape (BE-09).
 *
 * The response always carries **every** documented key. A row that has never
 * had a `creator_token`, or that predates a column being added, comes back from
 * Postgres with those properties absent or `undefined`; passing that straight
 * through `res.json` drops the keys entirely, so the same account serializes
 * differently depending on which columns happen to be populated.
 *
 * Clients then have to treat a missing key and an explicit `null` as two
 * different things — `profile.creator_token ?? fallback` works, but
 * `'creator_token' in profile` and any generated OpenAPI type disagree with the
 * documented shape. Normalizing absent/undefined to `null` here makes the
 * contract stable: the keys are always present, and "not set" is always `null`.
 */
function serializeProfile(profile: Profile): ProfileResponse {
  return {
    address: profile.address,
    username: profile.username ?? "",
    creator_token: profile.creator_token ?? "",
    updated_ledger: profile.updated_ledger ?? 0,
  };
}

/** The fields a profile update may set, and whether each one is required. */
interface ProfileUpdateBody {
  username: string;
  creator_token?: string;
}

interface ProfileUpdateResult {
  body: ProfileUpdateBody;
}

/**
 * Validate a profile update body.
 *
 * Every field is checked *before* anything is written, and the first failure is
 * returned with the offending field name, so a request carrying one bad field
 * never applies the others. Validating field-by-field inside the write loop is
 * what produces partial updates: a profile ends up with the new username and
 * the old creator token, with no indication that half the request was refused.
 */
function parseProfileUpdateBody(raw: unknown): ValidationResult<ProfileUpdateResult> {
  const source = (
    typeof raw === "object" && raw !== null ? raw : {}
  ) as Record<string, unknown>;

  const username = parseUsername(source.username, "username");
  if (!username.ok) return username;

  const creatorToken = parseOptionalStellarAddress(source.creator_token, "creator_token");
  if (!creatorToken.ok) return creatorToken;

  return {
    ok: true,
    value: {
      body: {
        username: username.value,
        ...(creatorToken.value === undefined ? {} : { creator_token: creatorToken.value }),
      },
    },
  };
}

export function createProfilesRouter(db: Database): Router {
  const router = Router();

  /**
   * GET /profiles/:address
   * Returns the profile for the given Stellar address.
   */
  router.get(
    "/:address",
    async (req: Request, res: Response<ProfileResponse | ApiErrorResponse>): Promise<void> => {
      const parsed = parseStellarAddress(req.params.address);
      if (!parsed.ok) {
        sendValidationError(res, parsed.issue);
        return;
      }

      const profile = await db.getProfile(parsed.value);
      if (!profile) {
        res.status(404).json({ error: "Profile not found", code: "NOT_FOUND" });
        return;
      }

      res.json(serializeProfile(profile));
    }
  );

  /**
   * PUT /profiles/:address
   * Updates the profile owned by `address`.
   *
   * Fields are validated as a set before the write, and the handler writes at
   * most once: a request with an invalid `creator_token` leaves the stored
   * profile untouched rather than half-updated (BE-06).
   */
  router.put(
    "/:address",
    async (req: Request, res: Response<ProfileResponse | ApiErrorResponse>): Promise<void> => {
      const address = parseStellarAddress(req.params.address);
      if (!address.ok) {
        sendValidationError(res, address.issue);
        return;
      }

      const parsed = parseProfileUpdateBody(req.body);
      if (!parsed.ok) {
        sendValidationError(res, parsed.issue);
        return;
      }

      const existing = await db.getProfile(address.value);
      if (!existing) {
        res.status(404).json({ error: "Profile not found", code: "NOT_FOUND" });
        return;
      }

      const profile: Profile = {
        ...existing,
        address: address.value,
        username: parsed.value.body.username,
        creator_token: parsed.value.body.creator_token ?? existing.creator_token,
      };

      await db.upsertProfile(profile);
      res.json(profile);
    }
  );

  return router;
}
