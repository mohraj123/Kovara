import { createHash } from 'crypto';

export interface CursorPaginationQuery {
  cursor?: string;
  limit: number;
}

export interface CursorPaginationResult<T> {
  data: T[];
  nextCursor?: string;
  hasMore: boolean;
}

/**
 * Opaque cursors are self-describing and integrity-checked so a truncated or
 * hand-edited value is rejected before it is ever used as a query parameter
 * (BE-021). Format: `v1.<base64url payload>.<8 hex checksum>`.
 */
const CURSOR_PREFIX = 'v1.';
const CURSOR_PATTERN = /^v1\.([A-Za-z0-9_-]+)\.([a-f0-9]{8})$/;
const CHECKSUM_LENGTH = 8;

/** Raised for any cursor that is malformed, truncated, or tampered with. */
export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

function checksumOf(payload: string): string {
  return createHash('sha256').update(payload, 'utf-8').digest('hex').slice(0, CHECKSUM_LENGTH);
}

/** Encode a cursor payload into the canonical, checked representation. */
export function encodeCursor(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidCursorError('cursor payload must be a non-empty string');
  }
  const payload = Buffer.from(value, 'utf8').toString('base64url');
  return `${CURSOR_PREFIX}${payload}.${checksumOf(payload)}`;
}

/**
 * Decode and validate a cursor. Anything that does not match the exact
 * canonical encoding (including a changed checksum) is rejected.
 */
export function decodeCursor(cursor: string): string {
  if (typeof cursor !== 'string') {
    throw new InvalidCursorError('cursor must be a string');
  }

  const match = CURSOR_PATTERN.exec(cursor.trim());
  if (!match) {
    throw new InvalidCursorError('cursor is malformed or truncated');
  }

  const [, payload, checksum] = match;
  if (checksumOf(payload) !== checksum) {
    throw new InvalidCursorError('cursor checksum mismatch');
  }

  const decoded = Buffer.from(payload, 'base64url').toString('utf8');
  // A non-canonical base64url spelling would decode fine but would let two
  // different strings address the same page; reject it.
  if (decoded === '' || Buffer.from(decoded, 'utf8').toString('base64url') !== payload) {
    throw new InvalidCursorError('cursor payload is not canonical');
  }
  return decoded;
}

/** Non-throwing form of {@link decodeCursor}, for validation at boundaries. */
export function isValidCursor(cursor: unknown): cursor is string {
  try {
    decodeCursor(cursor as string);
    return true;
  } catch {
    return false;
  }
}
