import { Router, Request, Response } from "express";
import { ApiErrorResponse } from "../contracts";
import { normalizeVoterIdentity } from "../../verification/quorum";
import { isStellarAddress } from "../validation";

/** A single community verification vote on a pending price submission. */
export interface VerificationVote {
  submissionId: string;
  voter: string;
  choice: "approve" | "reject";
  votedAt: string;
}

/**
 * In-process store keyed by submissionId → voter → vote.
 *
 * Scaffolding for the community verification workflow (issue #643): keeps
 * the one-voter-per-submission constraint enforceable without requiring a
 * schema/migration change in this pass. A production deployment should move
 * this into the `Database` layer (see Backend/src/db.ts) once the
 * verification schema is finalized; this module's shape (submissionId,
 * voter, choice, votedAt) is designed to map directly onto a future table.
 */
const votesBySubmission = new Map<string, Map<string, VerificationVote>>();

const VALID_CHOICES = new Set(["approve", "reject"]);

export function createVerificationVotesRouter(): Router {
  const router = Router();

  /**
   * POST /verification-votes
   * Body: { submissionId: string, voter: string, choice: "approve" | "reject" }
   *
   * Records a contributor's verification vote for a pending submission.
   * Only a well-formed Stellar address may vote, and a given voter may cast
   * only one vote per submission (resubmitting overwrites their prior
   * choice rather than creating a duplicate).
   */
  router.post(
    "/",
    (req: Request, res: Response<{ vote: VerificationVote } | ApiErrorResponse>): void => {
      const { submissionId, voter, choice } = req.body ?? {};

      if (typeof submissionId !== "string" || submissionId.trim() === "") {
        res.status(400).json({ error: "submissionId is required", code: "INVALID_SUBMISSION_ID" });
        return;
      }

      const normalizedVoter =
        typeof voter === "string" ? normalizeVoterIdentity(voter) : undefined;
      if (!normalizedVoter || !isStellarAddress(normalizedVoter)) {
        res.status(400).json({
          error: "voter must be a valid Stellar address: starts with 'G', 56 alphanumeric characters",
          code: "INVALID_VOTER",
        });
        return;
      }

      if (typeof choice !== "string" || !VALID_CHOICES.has(choice)) {
        res.status(400).json({
          error: `choice must be one of: ${[...VALID_CHOICES].join(", ")}`,
          code: "INVALID_CHOICE",
        });
        return;
      }

      const vote: VerificationVote = {
        submissionId,
        voter: normalizedVoter,
        choice: choice as "approve" | "reject",
        votedAt: new Date().toISOString(),
      };

      let votes = votesBySubmission.get(submissionId);
      if (!votes) {
        votes = new Map();
        votesBySubmission.set(submissionId, votes);
      }
      votes.set(normalizedVoter, vote);

      res.status(201).json({ vote });
    }
  );

  /**
   * GET /verification-votes/:submissionId
   * Lists every recorded vote for a given submission.
   */
  router.get(
    "/:submissionId",
    (req: Request, res: Response<{ votes: VerificationVote[] }>): void => {
      const { submissionId } = req.params;
      const votes = votesBySubmission.get(submissionId);
      res.json({ votes: votes ? [...votes.values()] : [] });
    }
  );

  return router;
}
