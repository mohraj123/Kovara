import { Response } from "express";

export interface ApiSuccess<T = unknown> {
  success: true;
  data: T;
  timestamp: string;
}

export interface ApiError {
  error: string;
  code: string;
}

export interface ApiPaginated<T = unknown> extends ApiSuccess<T> {
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export function sendSuccess<T>(res: Response, data: T, status = 200): void {
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
  offset: number
): void {
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
  const body: ApiError = {
    error,
    code,
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