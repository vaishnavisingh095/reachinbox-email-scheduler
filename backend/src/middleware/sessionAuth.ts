import type { NextFunction, Request, Response } from "express";
import { readSessionFromRequest } from "../auth/session";
import { sendError } from "../lib/httpErrors";

/**
 * The real, production auth middleware (ADR-012). Reads and verifies the
 * signed session cookie — never trusts a caller-supplied user id. This is
 * what ADR-023's temporary X-Dev-User-Id shim is superseded by.
 */
export function sessionAuth(req: Request, res: Response, next: NextFunction) {
  const session = readSessionFromRequest(req);
  if (!session) {
    sendError(res, 401, "UNAUTHENTICATED", "Missing or invalid session");
    return;
  }
  req.userId = session.sub;
  req.userEmail = session.email;
  next();
}
