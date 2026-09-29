import jwt from "jsonwebtoken";
import { env } from "../config/env";

const SLACK_REDIRECT_URI = `${env.API_URL}/auth/slack/callback`;

/**
 * architecture.md's Slack OAuth section: "a signed `state` value that
 * encodes the user id, so the callback can't be forged into attaching a
 * token to the wrong account." Reuses SESSION_SECRET (a distinct payload
 * shape from the session cookie — {purpose, userId} — so the two token
 * kinds can't be confused with each other) rather than introducing a
 * second secret.
 */
export function signSlackState(userId: string): string {
  return jwt.sign({ purpose: "slack-oauth-state", userId }, env.SESSION_SECRET, { expiresIn: "10m" });
}

export function verifySlackState(state: string): string | null {
  try {
    const payload = jwt.verify(state, env.SESSION_SECRET) as { purpose?: string; userId?: string };
    if (payload.purpose !== "slack-oauth-state" || !payload.userId) return null;
    return payload.userId;
  } catch {
    return null;
  }
}

export function buildSlackAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    scope: "incoming-webhook",
    redirect_uri: SLACK_REDIRECT_URI,
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export interface SlackExchangeResult {
  teamId: string;
  teamName: string;
  webhookUrl: string | null;
  accessToken: string | null;
  channelId: string | null;
}

export async function exchangeSlackCode(code: string): Promise<SlackExchangeResult> {
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: SLACK_REDIRECT_URI,
    }),
  });
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    team?: { id: string; name: string };
    incoming_webhook?: { url: string; channel_id: string };
    access_token?: string;
  };
  if (!data.ok) {
    throw new Error(`Slack OAuth exchange failed: ${data.error ?? "unknown error"}`);
  }
  return {
    teamId: data.team?.id ?? "",
    teamName: data.team?.name ?? "",
    webhookUrl: data.incoming_webhook?.url ?? null,
    accessToken: data.access_token ?? null,
    channelId: data.incoming_webhook?.channel_id ?? null,
  };
}

export interface SlackTarget {
  webhookUrl: string | null;
  accessToken: string | null;
  channelId: string | null;
}

/**
 * Posts to whichever target the connection has: an incoming webhook (the
 * primary path here — one webhook URL per authorized channel) or a bot
 * token + channel id, per architecture.md's documented "either" design.
 */
export async function postSlackMessage(target: SlackTarget, text: string): Promise<void> {
  if (target.webhookUrl) {
    const res = await fetch(target.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      throw new Error(`Slack webhook post failed: ${res.status} ${await res.text()}`);
    }
    return;
  }

  if (target.accessToken && target.channelId) {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${target.accessToken}` },
      body: JSON.stringify({ channel: target.channelId, text }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      throw new Error(`Slack chat.postMessage failed: ${data.error ?? "unknown error"}`);
    }
    return;
  }

  throw new Error("Slack connection has neither a webhook URL nor an access token + channel id");
}
