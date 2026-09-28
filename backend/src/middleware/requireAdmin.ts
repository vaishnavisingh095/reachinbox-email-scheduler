import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { sendError } from "../lib/httpErrors";

const adminEmails = new Set(
  env.ADMIN_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

/**
 * Bull Board's admin gate (architecture.md's Bull Board section): session
 * + an ADMIN_EMAILS allow-list — a valid login alone isn't sufficient.
 * Must run after an auth middleware that sets req.userEmail.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.userEmail || !adminEmails.has(req.userEmail.toLowerCase())) {
    sendError(res, 403, "NOT_ADMIN", "This account is not on the admin allow-list");
    return;
  }
  next();
}
