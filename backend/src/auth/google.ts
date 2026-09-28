import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env";

const REDIRECT_URI = `${env.API_URL}/auth/google/callback`;

function createOAuthClient() {
  return new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, REDIRECT_URI);
}

export function buildGoogleAuthorizeUrl(state: string): string {
  return createOAuthClient().generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    state,
    prompt: "select_account",
  });
}

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * ADR-012: server-side token exchange, then server-side ID token
 * verification (signature and audience) — via google-auth-library's
 * verifyIdToken, not by trusting a subsequent profile-endpoint call.
 */
export async function exchangeCodeForGoogleProfile(code: string): Promise<GoogleProfile> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) {
    throw new Error("Google token exchange did not return an id_token");
  }

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error("Google ID token payload missing sub/email");
  }
  // Account linking itself is keyed on `sub` (below), not email, so this
  // isn't an account-takeover vector — but `email` is later checked
  // against ADMIN_EMAILS for Bull Board access (requireAdmin.ts), so an
  // unverified email is still a real authorization-boundary concern worth
  // rejecting outright rather than trusting silently.
  if (payload.email_verified !== true) {
    throw new Error("Google account email is not verified");
  }

  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name ?? payload.email,
    avatarUrl: payload.picture ?? null,
  };
}
