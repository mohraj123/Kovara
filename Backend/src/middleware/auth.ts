/**
 * Authentication and authorization middleware (#666).
 *
 * The API accepted an `authMiddleware` option but never applied it, so every
 * endpoint was effectively public regardless of configuration. These helpers
 * make the policy explicit and, more importantly, testable:
 *
 *   - {@link createTokenAuthMiddleware} performs *authentication*: it decides
 *     whether a request carries a valid credential (401 when it does not).
 *   - {@link requireRole} performs *authorization*: given an authenticated
 *     request, it decides whether the caller may perform the action (403 when
 *     it may not).
 *
 * Keeping the two separate is what makes a permission boundary assertable: a
 * test can distinguish "you did not identify yourself" from "we know who you
 * are and you are not allowed to do this", which are different client bugs.
 */

import { Request, Response, NextFunction } from "express";

/** A middleware compatible with `app.use()` and `AppOptions.authMiddleware`. */
export type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => void;

/** The identity attached to a request once authentication succeeds. */
export interface AuthContext {
  /** Who the caller is (token subject, address, principal id). */
  subject: string;
  /** What the caller may do. */
  roles: string[];
}

/** An Express request after authentication has populated `auth`. */
export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

/** The standard 401 body. */
export function sendUnauthorized(res: Response): void {
  res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
}

/** The standard 403 body. */
export function sendForbidden(res: Response, message = "Forbidden"): void {
  res.status(403).json({ error: message, code: "FORBIDDEN" });
}

/** Pass every request through unchanged. The default when auth is off. */
export const noopAuthMiddleware: AuthMiddleware = (_req, _res, next) => next();

/**
 * Bearer-token authentication.
 *
 * When no secret is configured the middleware denies every request rather than
 * allowing them: a misconfigured server should fail closed. Deployments that
 * want anonymous access simply do not install this middleware.
 */
export function createTokenAuthMiddleware(secret: string | undefined): AuthMiddleware {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!secret) {
      sendUnauthorized(res);
      return;
    }

    const header = req.headers.authorization;
    const token =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length).trim()
        : "";

    if (token === "" || token !== secret) {
      sendUnauthorized(res);
      return;
    }

    (req as AuthenticatedRequest).auth = { subject: token, roles: ["admin"] };
    next();
  };
}

/**
 * Authorization gate: require the authenticated caller to hold at least one of
 * `roles`. Must run after an authentication middleware.
 *
 * An unauthenticated request is still a 401 — the caller has not identified
 * themselves, so the server cannot say they lack the role. Only once an
 * identity is known does "you are not allowed" become a 403.
 */
export function requireRole(...roles: string[]): AuthMiddleware {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      sendUnauthorized(res);
      return;
    }
    if (!roles.some((role) => auth.roles.includes(role))) {
      sendForbidden(res, "Insufficient permissions");
      return;
    }
    next();
  };
}
