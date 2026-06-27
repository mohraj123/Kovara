/**
 * Base class for all Kovara SDK errors.
 */
export class KovaraError extends Error {
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
export class NotFoundError extends KovaraError {}

/**
 * Thrown when the caller is unauthorized (e.g., trying to modify another user's post,
 * pool withdraw without being a pool admin, or trying to interact with a blocker).
 */
export class UnauthorizedError extends KovaraError {}

/**
 * Thrown when the caller has insufficient funds or insufficient token allowance for operations.
 */
export class InsufficientBalanceError extends KovaraError {}

/**
 * Thrown when the tipping cooldown window is active.
 */
export class CooldownError extends KovaraError {}

/**
 * Thrown when input parameters fail pre-flight validation (invalid username, post content length limits, etc.).
 */
export class InvalidInputError extends KovaraError {}

/**
 * Thrown when the indexer returns a non-200 HTTP response.
 * Carries the HTTP `statusCode` so callers can surface context-specific messages.
 */
export class IndexerError extends KovaraError {
  constructor(
    message: string,
    public readonly statusCode: number,
    originalError?: unknown
  ) {
    super(message, originalError);
  }
}

/**
 * Thrown when a mini-app manifest fails JSON schema validation.
 */
export class InvalidManifestError extends KovaraError {}

/**
 * Maps a raw error string or transaction simulation response error to a specific KovaraError subclass.
 *
 * @param err The caught raw error object or string.
 * @returns A typed KovaraError instance.
 */
/**
 * Converts a non-200 HTTP response into an `IndexerError` with an appropriate message.
 * Use this wherever you call the indexer REST API.
 *
 * @param statusCode The HTTP status code returned by the indexer.
 * @param body Optional response body text for additional context.
 */
export function mapHttpError(statusCode: number, body?: string): IndexerError {
  const detail = body ? `: ${body}` : "";
  if (statusCode === 404) {
    return new IndexerError(`Indexer: resource not found${detail}`, statusCode);
  }
  if (statusCode === 429) {
    return new IndexerError(`Indexer: rate limit exceeded${detail}`, statusCode);
  }
  if (statusCode === 401 || statusCode === 403) {
    return new IndexerError(`Indexer: access denied${detail}`, statusCode);
  }
  if (statusCode === 503) {
    return new IndexerError(`Indexer: service unavailable${detail}`, statusCode);
  }
  if (statusCode === 502 || statusCode === 504) {
    return new IndexerError(`Indexer: gateway error${detail}`, statusCode);
  }
  if (statusCode >= 500) {
    return new IndexerError(`Indexer: internal server error (${statusCode})${detail}`, statusCode);
  }
  return new IndexerError(`Indexer: unexpected status ${statusCode}${detail}`, statusCode);
}

export function mapError(err: unknown): Error {
  // Pass through already-typed SDK errors unchanged.
  if (err instanceof KovaraError) return err;
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

  return new KovaraError(msg, err);
}
