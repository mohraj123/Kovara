import { Router, Request, Response } from "express";
import { ApiErrorResponse } from "../contracts";
import { isFailure, validateEnum, validateStellarAddress, validateString } from "../validation";

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

      // #665: every caller-controlled field is validated before it is stored.
      const validatedId = validateString(submissionId, "submissionId", {
        maxLength: 128,
        code: "INVALID_SUBMISSION_ID",
      });
      if (isFailure(validatedId)) {
        res.status(400).json(validatedId.failure);
        return;
      }

      const validatedVoter = validateStellarAddress(voter, "voter");
      if (isFailure(validatedVoter)) {
        res.status(400).json({ ...validatedVoter.failure, code: "INVALID_VOTER" });
        return;
      }

      const validatedChoice = validateEnum(choice, [...VALID_CHOICES] as ("approve" | "reject")[], "choice", "INVALID_CHOICE");
      if (isFailure(validatedChoice)) {
        res.status(400).json(validatedChoice.failure);
        return;
      }

      const vote: VerificationVote = {
        submissionId: validatedId.value,
        voter: validatedVoter.value,
        choice: validatedChoice.value,
        votedAt: new Date().toISOString(),
      };

      let votes = votesBySubmission.get(validatedId.value);
      if (!votes) {
        votes = new Map();
        votesBySubmission.set(validatedId.value, votes);
      }
      votes.set(validatedVoter.value, vote);

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
