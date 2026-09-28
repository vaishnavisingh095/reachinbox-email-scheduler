import { randomUUID } from "node:crypto";
import { Router } from "express";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { sendError } from "../lib/httpErrors";
import { buildGoogleAuthorizeUrl, exchangeCodeForGoogleProfile } from "../auth/google";
import { setSessionCookie, clearSessionCookie, readSessionFromRequest } from "../auth/session";

export const authRouter = Router();

const OAUTH_STATE_COOKIE = "google_oauth_state";

// GET /auth/google — start the flow. A random, unguessable state is set in
// a short-lived httpOnly cookie and echoed back by Google; the callback
// rejects any request whose state doesn't match its own cookie (CSRF
// protection — an attacker can't read or set this cookie for our domain).
authRouter.get("/google", (_req, res) => {
  const state = randomUUID();
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    maxAge: 10 * 60 * 1000,
    path: "/",
  });
  res.redirect(buildGoogleAuthorizeUrl(state));
});

// GET /auth/google/callback — exchange code, verify ID token, upsert user,
// set session cookie, redirect to the frontend.
authRouter.get("/google/callback", async (req, res) => {
  const { code, state } = req.query;
  const expectedState = req.cookies?.[OAUTH_STATE_COOKIE];
  res.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });

  if (!code || typeof code !== "string") {
    sendError(res, 400, "OAUTH_ERROR", "Missing authorization code");
    return;
  }
  if (!state || typeof state !== "string" || !expectedState || state !== expectedState) {
    sendError(res, 400, "OAUTH_STATE_MISMATCH", "OAuth state did not match — possible CSRF or expired flow");
    return;
  }

  try {
    const profile = await exchangeCodeForGoogleProfile(code);
    const user = await prisma.user.upsert({
      where: { googleId: profile.googleId },
      create: { googleId: profile.googleId, email: profile.email, name: profile.name, avatarUrl: profile.avatarUrl },
      update: { email: profile.email, name: profile.name, avatarUrl: profile.avatarUrl },
    });
    setSessionCookie(res, { sub: user.id, email: user.email });
    res.redirect(env.FRONTEND_URL + "/dashboard");
  } catch (err) {
    console.error("[auth/google/callback] OAuth exchange failed:", err);
    sendError(res, 401, "OAUTH_EXCHANGE_FAILED", "Google sign-in failed");
  }
});

// GET /auth/me — current session user for the header.
authRouter.get("/me", async (req, res) => {
  const session = readSessionFromRequest(req);
  if (!session) {
    sendError(res, 401, "UNAUTHENTICATED", "No valid session");
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: session.sub } });
  if (!user) {
    sendError(res, 401, "UNAUTHENTICATED", "Session refers to a user that no longer exists");
    return;
  }
  res.status(200).json({ id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl });
});

// POST /auth/logout — clear the cookie. No server-side record to
// invalidate (ADR-012): the cookie itself is the credential.
authRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
});
