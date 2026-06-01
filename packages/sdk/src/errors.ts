/**
 * Base class for all Linkora SDK errors.
 */
export class LinkoraError extends Error {
  constructor(
    message: string,
    public readonly originalError?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
    // Set prototype explicitly to support instanceof checks in compiled environments.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a requested resource (e.g. post, pool, or profile) does not exist on-chain.
 */
export class NotFoundError extends LinkoraError {}

/**
 * Thrown when the caller is unauthorized (e.g., trying to modify another user's post,
 * pool withdraw without being a pool admin, or trying to interact with a blocker).
 */
export class UnauthorizedError extends LinkoraError {}

/**
 * Thrown when the caller has insufficient funds or insufficient token allowance for operations.
 */
export class InsufficientBalanceError extends LinkoraError {}

/**
 * Thrown when the tipping cooldown window is active.
 */
export class CooldownError extends LinkoraError {}

/**
 * Thrown when input parameters fail pre-flight validation (invalid username, post content length limits, etc.).
 */
export class InvalidInputError extends LinkoraError {}

/**
 * Thrown when a mini-app manifest fails JSON schema validation.
 */
export class InvalidManifestError extends LinkoraError {}

/**
 * Maps a raw error string or transaction simulation response error to a specific LinkoraError subclass.
 *
 * @param err The caught raw error object or string.
 * @returns A typed LinkoraError instance.
 */
export function mapError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);

  if (/allowance|insufficient allowance/i.test(msg)) {
    return new InsufficientBalanceError("Insufficient allowance to complete transaction.", err);
  }
  if (/balance|low balance|insufficient balance/i.test(msg)) {
    return new InsufficientBalanceError("Insufficient account balance for this transaction.", err);
  }
  if (/unauthorized|not admin|only admin|only author/i.test(msg)) {
    return new UnauthorizedError("Unauthorized operation. You do not have permission.", err);
  }
  if (/blocked/i.test(msg)) {
    return new UnauthorizedError("Operation rejected: user has blocked you.", err);
  }
  if (/not found|does not exist/i.test(msg)) {
    return new NotFoundError("The requested resource was not found.", err);
  }
  if (/cooldown/i.test(msg)) {
    return new CooldownError("Tipping cooldown has not expired yet.", err);
  }
  if (/invalid|too long|must be positive|cannot exceed/i.test(msg)) {
    return new InvalidInputError(`Invalid input parameters: ${msg}`, err);
  }

  return new LinkoraError(msg, err);
}
