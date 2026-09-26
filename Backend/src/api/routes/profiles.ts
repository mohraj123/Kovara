import { Router, Request, Response } from "express";
import { Database } from "../../db";
import { ApiErrorResponse, ProfileResponse } from "../contracts";
import { isStellarAddress, settle, validateStellarAddress } from "../validation";

/**
 * Validates that the given string is a well-formed Stellar public key.
 * Stellar addresses start with 'G' and are exactly 56 alphanumeric characters.
 *
 * Kept as an exported name for back-compatibility with existing callers and
 * tests; the canonical shape check now lives in `../validation` (#665).
 */
export function isValidStellarAddress(addr: string): boolean {
  return isStellarAddress(addr);
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
      const { address } = req.params;

      // #665: address shape is validated before any database access.
      const validatedAddress = settle(res, validateStellarAddress(address));
      if (validatedAddress === null) return;

      const profile = await db.getProfile(validatedAddress);
      if (!profile) {
        res.status(404).json({ error: "Profile not found", code: "NOT_FOUND" });
        return;
      }

      res.json(profile);
    }
  );

  return router;
}
