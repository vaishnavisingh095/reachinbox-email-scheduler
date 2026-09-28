import { Router } from "express";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { sendError } from "../lib/httpErrors";
import { requireAuth } from "../middleware/authMode";
import { buildSlackAuthorizeUrl, exchangeSlackCode, signSlackState, verifySlackState } from "../lib/slack";

export const slackRouter = Router();

// GET /slack/install — requires an existing session (a user must already
// be logged in to connect Slack to their account).
slackRouter.get("/install", requireAuth, (req, res) => {
  const state = signSlackState(req.userId!);
  res.redirect(buildSlackAuthorizeUrl(state));
});

// GET /slack/callback — auth is the signed state itself, not a fresh
// session check (architecture.md: "session cookie (via signed `state`)")
// — the state is what proves this callback belongs to the user who
// started the /install flow.
slackRouter.get("/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || typeof code !== "string" || !state || typeof state !== "string") {
    sendError(res, 400, "OAUTH_ERROR", "Missing code or state");
    return;
  }
  const userId = verifySlackState(state);
  if (!userId) {
    sendError(res, 400, "OAUTH_STATE_MISMATCH", "Invalid or expired Slack OAuth state");
    return;
  }

  try {
    const result = await exchangeSlackCode(code);
    await prisma.slackConnection.upsert({
      where: { userId },
      create: {
        userId,
        teamId: result.teamId,
        teamName: result.teamName,
        webhookUrl: result.webhookUrl,
        accessToken: result.accessToken,
        channelId: result.channelId,
      },
      update: {
        teamId: result.teamId,
        teamName: result.teamName,
        webhookUrl: result.webhookUrl,
        accessToken: result.accessToken,
        channelId: result.channelId,
      },
    });
    res.redirect(env.FRONTEND_URL + "/dashboard");
  } catch (err) {
    console.error("[slack/callback] OAuth exchange failed:", err);
    sendError(res, 401, "OAUTH_EXCHANGE_FAILED", "Slack connection failed");
  }
});

// GET /slack/status — is Slack connected, for which team.
slackRouter.get("/status", requireAuth, async (req, res) => {
  const connection = await prisma.slackConnection.findUnique({ where: { userId: req.userId } });
  if (!connection) {
    res.status(200).json({ connected: false });
    return;
  }
  res.status(200).json({ connected: true, teamName: connection.teamName });
});

// DELETE /slack — disconnect. Reconnecting afterward is just a fresh
// /slack/install -> /slack/callback upsert.
slackRouter.delete("/", requireAuth, async (req, res) => {
  await prisma.slackConnection.deleteMany({ where: { userId: req.userId } });
  res.status(200).json({ ok: true });
});
