import jwt from "jsonwebtoken";
import type { CookieOptions, Request, Response } from "express";
import { env } from "../config/env";

// ADR-012: "a signed JWT is sufficient; no separate session store is
// required." The cookie itself is the credential.
const SESSION_COOKIE = "session";
const SESSION_TTL = "7d";

export interface SessionPayload {
  sub: string; // users.id
  email: string;
}

export function signSession(payload: SessionPayload): string {
  return jwt.sign(payload, env.SESSION_SECRET, { expiresIn: SESSION_TTL });
}

export function verifySession(token: string): SessionPayload | null {
  try {
    return jwt.verify(token, env.SESSION_SECRET) as SessionPayload;
  } catch {
    return null;
  }
}

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  };
}

export function setSessionCookie(res: Response, payload: SessionPayload) {
  res.cookie(SESSION_COOKIE, signSession(payload), cookieOptions());
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined });
}

export function readSessionFromRequest(req: Request): SessionPayload | null {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || typeof token !== "string") return null;
  return verifySession(token);
}

export { SESSION_COOKIE };
