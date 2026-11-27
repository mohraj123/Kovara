import { Response } from "express";
import { getRequestId } from "../request-context";

export interface ApiSuccess<T = unknown> {
  success: true;
  data: T;
  timestamp: string;
}

export interface ApiError {
  error: string;
  code: string;
  /** Matches the `X-Request-Id` / `X-Correlation-Id` headers (BE-017). */
  requestId?: string;
}

export interface ApiPaginated<T = unknown> extends ApiSuccess<T> {
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface SendOptions {
  /**
   * The body depends on the caller (a wallet or address). It must not be
   * stored by shared/intermediary caches, so `private, no-store` is applied.
   */
  personalized?: boolean;
}

/**
 * Cache headers for personalized responses. `Vary` keeps any cache that does
 * store the response from serving it to a different caller.
 */
export function applyCacheHeaders(res: Response, options: SendOptions = {}): void {
  if (options.personalized) {
    res.set("Cache-Control", "private, no-store");
    res.vary("Authorization");
    res.vary("X-Wallet-Address");
  }
}

export function sendSuccess<T>(res: Response, data: T, status = 200, options: SendOptions = {}): void {
  applyCacheHeaders(res, options);
  const body: ApiSuccess<T> = {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
  res.status(status).json(body);
}

export function sendPaginated<T>(
  res: Response,
  data: T,
  total: number,
  limit: number,
  offset: number,
  options: SendOptions = {}
): void {
  applyCacheHeaders(res, options);
  const body: ApiPaginated<T> = {
    success: true,
    data,
    total,
    limit,
    offset,
    has_more: offset + (Array.isArray(data) ? data.length : 0) < total,
    timestamp: new Date().toISOString(),
  };
  res.json(body);
}

export function sendError(
  res: Response,
  status: number,
  error: string,
  code: string,
  _details?: unknown
): void {
  const requestId = getRequestId();
  const body: ApiError = {
    error,
    code,
    // Serialized here as well as by the request-id middleware so direct
    // callers of sendError get the same traceable shape.
    ...(requestId ? { requestId } : {}),
  };
  res.status(status).json(body);
}

export function sendValidationError(res: Response, message: string): void {
  sendError(res, 400, message, "INVALID_QUERY");
}

export function sendNotFound(res: Response, resource: string): void {
  sendError(res, 404, `${resource} not found`, "NOT_FOUND");
}

export function sendRateLimitError(res: Response, retryAfterSeconds: number): void {
  const body: ApiError = {
    error: "Too many requests. Please retry after the indicated delay.",
    code: "RATE_LIMIT_EXCEEDED",
  };
  res.status(429).set("Retry-After", String(retryAfterSeconds)).json(body);
}