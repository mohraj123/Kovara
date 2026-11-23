/**
 * Deciding which search response may update the screen (FE-23).
 *
 * A search screen runs one request per keystroke burst, so several can be in
 * flight at once and they can settle out of order. Applying an older response
 * after a newer one has already landed puts the wrong rows under the query the
 * user is currently looking at — the classic "type `m`, type `music`, see Maya"
 * bug.
 *
 * The rule is expressed here as a pure function rather than inline in the
 * effect, because an inline `cancelled` boolean looks correct and is not: it
 * records that a run was cleaned up, which is true both for a run superseded by
 * a newer query and for one abandoned at unmount. It cannot say "this response
 * belongs to the query on screen right now".
 */

/** Identifies one started search. */
export interface SearchRequest {
  /** The query string this request was issued for. */
  query: string;
  /** Monotonic id, incremented per started search. */
  requestId: number;
}

export function shouldApplySearchResult(
  request: SearchRequest,
  latestRequestId: number,
  currentQuery: string
): boolean {
  // A newer search has already started: this response belongs to an older one.
  if (request.requestId !== latestRequestId) return false;

  // Belt and braces: even the newest request is stale if the query on screen has
  // moved on (e.g. the debounce has not fired yet for the newest keystroke).
  if (request.query !== currentQuery) return false;

  return true;
}
