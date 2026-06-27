import { Router, Request, Response } from "express";
import { Database } from "../../db";
import { ApiErrorResponse, ProfileResponse } from "../contracts";

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

      if (!address || typeof address !== "string" || address.trim() === "") {
        res.status(400).json({ error: "address is required", code: "INVALID_ADDRESS" });
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
