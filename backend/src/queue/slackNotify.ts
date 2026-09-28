import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import { postSlackMessage } from "../lib/slack";

/**
 * architecture.md's Slack rate-limit notification section, implemented as
 * documented: worker-side (the process that observes the limit), looked up
 * fresh per call (not cached at startup — a user connecting mid-session
 * starts getting notifications on the very next limit hit), deduplicated
 * one-per-(sender,hourWindow) via `SET NX`, and a complete no-op — never a
 * crash, never affecting the reschedule it accompanies — when nothing is
 * connected.
 */
export async function notifyRateLimitBlocked(params: {
  userId: string;
  senderId: string;
  senderEmail: string;
  campaignSubject: string;
  hourWindow: string;
}): Promise<void> {
  const { userId, senderId, senderEmail, campaignSubject, hourWindow } = params;

  try {
    const connection = await prisma.slackConnection.findUnique({ where: { userId } });
    if (!connection) {
      return; // no connection: rate limiting continues normally, nothing to notify.
    }

    const dedupeKey = `slack:notified:${senderId}:${hourWindow}`;
    const acquired = await redis.set(dedupeKey, "1", "EX", 2 * 60 * 60, "NX");
    if (acquired !== "OK") {
      return; // already notified for this sender+window.
    }

    const text =
      `:warning: *Rate limit reached* for sender \`${senderEmail}\` (campaign "${campaignSubject}"): ` +
      `the hourly send limit was hit. Remaining emails have been rescheduled into the next window — nothing was dropped or failed.`;

    await postSlackMessage(
      { webhookUrl: connection.webhookUrl, accessToken: connection.accessToken, channelId: connection.channelId },
      text
    );
  } catch (err) {
    // Must never crash the worker or affect the reschedule it accompanies.
    console.error(`[slack] failed to send rate-limit notification for sender ${senderId}:`, err);
  }
}
