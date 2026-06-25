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
  if (!(error instanceof Error)) return MESSAGES.UNKNOWN;

  const msg = error.message.toLowerCase();

  if (msg.includes("unauthorized") || msg.includes("auth"))
    return MESSAGES.UNAUTHORIZED;
  if (msg.includes("invalid") || msg.includes("state"))
    return MESSAGES.INVALID_STATE;
  if (msg.includes("not found") || msg.includes("notfound"))
    return MESSAGES.NOT_FOUND;
  if (msg.includes("already") || msg.includes("exists"))
    return MESSAGES.ALREADY_EXISTS;

  return MESSAGES.UNKNOWN;
}