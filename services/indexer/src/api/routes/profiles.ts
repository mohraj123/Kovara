import { Router, Request, Response } from "express";
import { Database } from "../../db";
import { ApiErrorResponse, ProfileResponse } from "../contracts";

const STELLAR_ADDRESS_LENGTH = 56;

/**
 * Validates that the given string is a well-formed Stellar public key.
 * Stellar addresses start with 'G' and are exactly 56 base-32 characters.
 */
export function isValidStellarAddress(addr: string): boolean {
  if (typeof addr !== "string") return false;
  if (addr.length !== STELLAR_ADDRESS_LENGTH) return false;
  if (addr[0] !== "G") return false;
  return /^[A-Z0-9]+$/.test(addr);
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
      if (req.correlationId) {
        res.set("X-Correlation-Id", req.correlationId);
      }

      const { address } = req.params;

      if (!address || typeof address !== "string" || address.trim() === "") {
        res.status(400).json({ error: "address is required", code: "INVALID_ADDRESS" });
        return;
      }

      if (!isValidStellarAddress(address)) {
        res.status(400).json({
          error: "Invalid Stellar address: must start with 'G' and be 56 alphanumeric characters",
          code: "INVALID_ADDRESS",
        });
        return;
      }

      const profile = await db.getProfile(address);
      if (!profile) {
        res.status(404).json({ error: "Profile not found", code: "NOT_FOUND" });
        return;
      }

      res.json(profile);
    }
  );

  return router;
}
