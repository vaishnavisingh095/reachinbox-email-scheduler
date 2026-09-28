import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";

/**
 * TEMPORARY, explicitly pre-OAuth request identity. This is NOT a real
 * authentication system — it exists only because Phase 4 needs some way to
 * attribute a POST /campaigns request to a user (sender ownership per
 * ADR-019, idempotency-key scoping per ADR-018) before Phase 7's real
 * Google OAuth / session-cookie middleware exists. It trusts a caller-
 * supplied header outright, which is only acceptable because nothing
 * downstream treats this as a security boundary yet (no session, no
 * cookie, no production deployment in scope). This entire file is meant
 * to be deleted and replaced by Phase 7's session-cookie middleware, not
 * extended.
 *
 * Usage: `X-Dev-User-Id: <a real users.id>` on the request.
 */
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}

export async function devAuth(req: Request, res: Response, next: NextFunction) {
  const userId = req.header("X-Dev-User-Id");
  if (!userId) {
    res.status(401).json({
      error: {
        code: "UNAUTHENTICATED",
        message:
          "Missing X-Dev-User-Id header. This is a temporary pre-OAuth dev shim (Phase 4) — real session auth lands in Phase 7.",
      },
    });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    res.status(401).json({
      error: { code: "UNAUTHENTICATED", message: "X-Dev-User-Id does not match any known user." },
    });
    return;
  }

  req.userId = user.id;
  req.userEmail = user.email;
  next();
}
