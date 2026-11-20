import express from "express";
import request from "supertest";
import { createVerificationVotesRouter } from "../routes/verification-votes";

describe("verification vote voter identity", () => {
  it("stores alternate address formatting under one canonical voter", async () => {
    const app = express();
    app.use(express.json());
    app.use("/verification-votes", createVerificationVotesRouter());
    const submissionId = `submission-${Date.now()}`;
    const voter = "GAZJ2EQV2ES6R5BLUNXMNFR5VN3HQF4KXJ2GM5Q7GQHT5XBC2CRX3GK3";

    const first = await request(app)
      .post("/verification-votes")
      .send({ submissionId, voter, choice: "approve" });
    const replacement = await request(app)
      .post("/verification-votes")
      .send({ submissionId, voter: ` ${voter.toLowerCase()} `, choice: "reject" });
    const listed = await request(app).get(`/verification-votes/${submissionId}`);

    expect(first.status).toBe(201);
    expect(replacement.status).toBe(201);
    expect(replacement.body.vote.voter).toBe(voter);
    expect(listed.body.votes).toHaveLength(1);
    expect(listed.body.votes[0]).toMatchObject({ voter, choice: "reject" });
  });
});
