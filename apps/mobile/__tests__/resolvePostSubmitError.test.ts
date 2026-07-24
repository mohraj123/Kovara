/**
 * Tests for the post-submission error categorizer.
 *
 * The composer needs to distinguish user-cancellations from network outages so
 * it can pick a sensible toast title and retry hint. The categorization lives
 * in `utils/contractErrors.ts`; these tests pin the mapping semantics.
 */

import { resolvePostSubmitError, mapContractError } from "../utils/contractErrors";

describe("resolvePostSubmitError", () => {
  it("classifies user-cancelled transactions", () => {
    expect(resolvePostSubmitError(new Error("User rejected the request"))).toEqual({
      code: "USER_REJECTED",
      message: expect.stringMatching(/cancel/i),
    });

    expect(resolvePostSubmitError(new Error("Transaction request rejected by the user"))).toEqual({
      code: "USER_REJECTED",
      message: expect.stringMatching(/cancel/i),
    });
  });

  it("classifies network failures distinctly from rejections", () => {
    expect(resolvePostSubmitError(new Error("Network request failed"))).toEqual({
      code: "NETWORK",
      message: expect.stringMatching(/network/i),
    });

    expect(resolvePostSubmitError(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toEqual({
      code: "NETWORK",
      message: expect.stringMatching(/network/i),
    });

    expect(resolvePostSubmitError(new Error("TypeError: Failed to fetch"))).toEqual({
      code: "NETWORK",
      message: expect.stringMatching(/network/i),
    });
  });

  it("classifies wallet-disconnected errors", () => {
    const err = new Error("Wallet not connected");
    expect(resolvePostSubmitError(err)).toEqual({
      code: "WALLET_DISCONNECTED",
      message: expect.stringMatching(/connect/i),
    });
  });

  it("classifies content validation errors raised by the contract", () => {
    expect(resolvePostSubmitError(new Error("contract error: content too long"))).toEqual({
      code: "CONTENT_INVALID",
      message: expect.stringMatching(/invalid/i),
    });

    expect(resolvePostSubmitError(new Error("contract error: empty content"))).toEqual({
      code: "CONTENT_INVALID",
      message: expect.stringMatching(/invalid/i),
    });
  });

  it("classifies contract-side authorization errors as UNAUTHORIZED", () => {
    expect(resolvePostSubmitError(new Error("only author can delete post"))).toEqual({
      code: "UNAUTHORIZED",
      message: expect.stringMatching(/not authorized/i),
    });
  });

  it("falls back to INTERNAL for unknown errors and uses the legacy mapper", () => {
    expect(resolvePostSubmitError(new Error("something completely different"))).toEqual({
      code: "INTERNAL",
      message: mapContractError(new Error("something completely different")),
    });
  });

  it("handles non-Error throwables (strings, null, undefined)", () => {
    expect(resolvePostSubmitError("user rejected signature")).toEqual({
      code: "USER_REJECTED",
      message: expect.stringMatching(/cancel/i),
    });

    expect(resolvePostSubmitError(null).code).toBe("INTERNAL");
    expect(resolvePostSubmitError(undefined).code).toBe("INTERNAL");
  });
});
