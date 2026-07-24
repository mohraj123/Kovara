/**
 * Resolves raw thrown values from the on-chain `createPost` (and other
 * mobile write helpers) into friendly, user-facing strings the composer can
 * display without ever leaking Soroban internals.
 *
 * This module is the single source of truth for "what message do we show the
 * user when X happens?".  Callers should NOT inspect raw `err.message` in UI
 * code — they should call `mapContractError` or `resolvePostSubmitError`.
 */

export type ContractErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_STATE"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "UNKNOWN";

const MESSAGES: Record<ContractErrorCode, string> = {
  UNAUTHORIZED: "You are not authorized to perform this action.",
  INVALID_STATE: "This action is not allowed in the current state.",
  NOT_FOUND: "The requested resource was not found.",
  ALREADY_EXISTS: "This item already exists.",
  UNKNOWN: "An unexpected error occurred. Please try again.",
};

export function mapContractError(error: unknown): string {
  if (!(error instanceof Error)) {
    return MESSAGES.UNKNOWN;
  }

  const msg = error.message.toLowerCase();

  if (msg.includes("unauthorized") || msg.includes("auth")) {
    return MESSAGES.UNAUTHORIZED;
  }
  if (msg.includes("invalid") || msg.includes("state")) {
    return MESSAGES.INVALID_STATE;
  }
  if (msg.includes("not found") || msg.includes("notfound")) {
    return MESSAGES.NOT_FOUND;
  }
  if (msg.includes("already") || msg.includes("exists")) {
    return MESSAGES.ALREADY_EXISTS;
  }

  return MESSAGES.UNKNOWN;
}

// ── Post-submission specific categorization ──────────────────────────────────
//
// Going beyond the coarse-grained `mapContractError`, post submission needs
// distinct buckets so the UI can:
//   - Show a different toast title for "you cancelled" vs "wallet offline".
//   - Optionally retry on transient network errors but not on user rejections.

export type PostSubmitErrorCode =
  | "WALLET_DISCONNECTED"
  | "USER_REJECTED"
  | "CONTENT_INVALID"
  | "UNAUTHORIZED"
  | "NETWORK"
  | "INTERNAL";

export interface PostSubmitError {
  message: string;
  code: PostSubmitErrorCode;
}

const USER_REJECTED_PATTERNS = [
  "user rejected",
  "user declined",
  "user cancelled",
  "user canceled",
  "request rejected",
  "transaction declined",
  "transaction canceled",
  "transaction cancelled",
  "denied by the user",
  "rejected by user",
];

const NETWORK_PATTERNS = [
  "network",
  "timeout",
  "timed out",
  "etimedout",
  "econnrefused",
  "econnreset",
  "enotfound",
  "failed to fetch",
  "fetch failed",
  "fetch api",
];

function matchesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message.toLowerCase();
  if (typeof err === "string") return err.toLowerCase();
  try {
    return String(err).toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Resolve any error thrown by the post-submission pipeline into a friendly
 * message + stable category code. Used by `useCreatePost` so the entire
 * composer can branch off a discriminated union instead of try/catching.
 */
export function resolvePostSubmitError(err: unknown): PostSubmitError {
  // Null / undefined is treated as an internal error — caller should never
  // throw nothing, but be defensive.
  if (err === null || err === undefined) {
    return { code: "INTERNAL", message: MESSAGES.UNKNOWN };
  }

  const message = extractMessage(err);

  // Order matters: specific categories must be tested before the catch-all
  // `mapContractError`/UNKNOWN fallback.
  if (matchesAny(message, USER_REJECTED_PATTERNS)) {
    return { code: "USER_REJECTED", message: "You canceled the transaction." };
  }

  if (matchesAny(message, NETWORK_PATTERNS)) {
    return {
      code: "NETWORK",
      message: "Network error. Check your connection and try again.",
    };
  }

  if (
    message.includes("wallet") &&
    (message.includes("not connected") || message.includes("disconnected"))
  ) {
    return {
      code: "WALLET_DISCONNECTED",
      message: "Your wallet is not connected. Reconnect and try again.",
    };
  }

  if (message.includes("content too long") || message.includes("empty content")) {
    return {
      code: "CONTENT_INVALID",
      message: "Post content is invalid (empty or too long).",
    };
  }

  if (message.includes("unauthorized") || message.includes("only author")) {
    return {
      code: "UNAUTHORIZED",
      message: "You are not authorized to perform this action.",
    };
  }

  if (message.includes("invalid")) {
    return {
      code: "CONTENT_INVALID",
      message: "Post content is invalid (empty or too long).",
    };
  }

  // Fall back to the coarse-grained map for everything else and tag it as
  // internal. This keeps user-facing copy consistent with the rest of the
  // app for shared error patterns.
  return { code: "INTERNAL", message: mapContractError(err) };
}
