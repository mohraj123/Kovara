/**
 * Request ID propagation (#684).
 *
 * The API already generated a correlation id for inbound requests, but it was
 * only echoed by three routes, was not accepted under a standard header name,
 * and was never attached to the outbound calls the backend makes. That made a
 * request impossible to follow once it left the HTTP handler.
 *
 * This module is the single place that decides:
 *   - where an inbound request id comes from (`X-Request-Id`, falling back to
 *     the legacy `X-Correlation-Id`) and how one is generated when absent;
 *   - how it reaches handlers (`req.requestId`, with `req.correlationId` kept
 *     as a back-compat alias) and logs (`getRequestId()`);
 *   - how it is returned to the caller (`X-Request-Id` + `X-Correlation-Id` on
 *     every response, success or error);
 *   - how it is copied onto outbound service calls
 *     (`outboundRequestHeaders()`).
 *
 * No new framework or dependency is involved: the id is bound to the request
 * with the built-in `AsyncLocalStorage` so non-HTTP code can read the id of the
 * call it is serving without threading it through every signature.
 */
import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";

/** Canonical request id header, used on requests and on responses. */
export const REQUEST_ID_HEADER = "x-request-id";
/** Legacy header retained so existing clients keep correlating. */
export const CORRELATION_ID_HEADER = "x-correlation-id";

const requestIdStore = new AsyncLocalStorage<string>();

declare global {
  namespace Express {
    interface Request {
      /** Canonical per-request id (#684). */
      requestId?: string;
      /** Back-compat alias of {@link Request.requestId}. */
      correlationId?: string;
    }
  }
}

/** Generate a fresh, unique request id. */
export function generateRequestId(): string {
  return randomUUID();
}

/**
 * Resolve the request id for an inbound call: the first non-empty value among
 * `X-Request-Id` and `X-Correlation-Id`, otherwise a generated id. Reads are
 * trimmed so a whitespace-only header is treated as missing.
 */
export function resolveRequestId(
  headers: Record<string, string | string[] | undefined>
): string {
  for (const name of [REQUEST_ID_HEADER, CORRELATION_ID_HEADER]) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed !== "") return trimmed;
  }
  return generateRequestId();
}

/** The request id bound to the current async execution, if any. */
export function getRequestId(): string | undefined {
  return requestIdStore.getStore();
}

/**
 * Add the active request id to an API error body when one is available.
 * Calls outside an HTTP request keep the original body unchanged.
 */
export function withRequestId<T>(
  body: T,
  requestId = getRequestId()
): T | (T & { requestId: string }) {
  if (
    !requestId ||
    body === null ||
    typeof body !== "object" ||
    !("error" in body) ||
    !("code" in body)
  ) {
    return body;
  }
  return { ...body, requestId };
}

/** Run `fn` with `requestId` bound to the current async execution. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestIdStore.run(requestId, fn);
}

/**
 * Inbound middleware: resolve a request id, expose it to handlers and logs, and
 * record it on the response before the route runs. Setting the header here
 * rather than per-route keeps success and error responses consistent.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const requestId = resolveRequestId(req.headers);
  req.requestId = requestId;
  // Back-compat: existing routes and the error handler read req.correlationId.
  req.correlationId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  res.setHeader(CORRELATION_ID_HEADER, requestId);
  const sendJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    const activeRequestId = getRequestId() ?? req.requestId;
    return sendJson(
      res.statusCode >= 400 ? withRequestId(body, activeRequestId) : body
    );
  }) as Response["json"];
  // Everything downstream of next() runs inside this scope, so outbound calls
  // and logs made while handling the request share the same id.
  runWithRequestId(requestId, next);
}

/**
 * Copy a request id onto outbound headers so an internal service call stays
 * correlated with its caller. Defaults to the id of the request currently being
 * handled, so a call site only has to opt in by using this helper.
 */
export function outboundRequestHeaders(
  headers: Record<string, string> = {},
  requestId: string | undefined = getRequestId()
): Record<string, string> {
  return requestId ? { ...headers, [REQUEST_ID_HEADER]: requestId } : { ...headers };
}
