import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { claimEmail } from "./claimEmail";
import { acquireSenderLock } from "../queue/senderLock";
import { checkAndIncrementRateLimits, getNextHourStart } from "../queue/rateLimit";
import { sendViaEthereal } from "../mail/ethereal";
import { recordRateWindowSend } from "./rateWindowAudit";

// A small random jitter so every blocked job for a sender doesn't retry at
// exactly the same instant (architecture.md's Minimum send delay / Hourly
// rate limiting sections both call for this).
function jitterMs(): number {
  return Math.floor(Math.random() * 250);
}

export type ProcessResult =
  | { outcome: "skipped"; reason: string }
  | { outcome: "sent"; messageId: string }
  | { outcome: "failed"; error: string }
  | { outcome: "rescheduled"; reason: "sender-lock" | "rate-limit"; scheduledAt: string };

function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    return [...err.errors].map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * The core per-job worker logic (architecture.md's Worker component / ADR
 * -003 through ADR-022). Ordering — claim, then the sender lock, then the
 * dual rate-limit check, then send — is chosen so that a granted rate-limit
 * slot is always immediately followed by an actual send attempt (nothing
 * can defer between "granted" and "sent"), which best matches ADR-007's
 * framing that a granted slot corresponds to an attempt, not something
 * deferred further by an unrelated check. This ordering isn't pinned down
 * verbatim in architecture.md (which predates the dual-quota mechanism);
 * it's an implementation detail chosen to preserve that invariant, not a
 * new data-model or externally-visible behavior change.
 */
export async function processEmail(emailId: string): Promise<ProcessResult> {
  const claimed = await claimEmail(emailId);
  if (!claimed) {
    return { outcome: "skipped", reason: "not in scheduled state (already claimed, sent, or failed)" };
  }

  const lockAcquired = await acquireSenderLock(claimed.senderId);
  if (!lockAcquired) {
    const scheduledAt = new Date(Date.now() + env.MIN_DELAY_MS + jitterMs());
    await prisma.email.update({
      where: { id: emailId },
      data: { status: "scheduled", scheduledAt },
    });
    return { outcome: "rescheduled", reason: "sender-lock", scheduledAt: scheduledAt.toISOString() };
  }

  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: claimed.campaignId } });
  const now = new Date();
  const rateLimitGranted = await checkAndIncrementRateLimits({
    senderId: claimed.senderId,
    campaignId: claimed.campaignId,
    senderLimit: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
    campaignLimit: campaign.hourlyLimit,
    now,
  });
  if (!rateLimitGranted) {
    const scheduledAt = new Date(getNextHourStart(now).getTime() + jitterMs());
    await prisma.email.update({
      where: { id: emailId },
      data: { status: "scheduled", scheduledAt },
    });
    return { outcome: "rescheduled", reason: "rate-limit", scheduledAt: scheduledAt.toISOString() };
  }

  const sender = await prisma.sender.findUniqueOrThrow({ where: { id: claimed.senderId } });

  try {
    const { messageId, previewUrl } = await sendViaEthereal(sender, campaign, claimed);
    // Written together, immediately after the send call succeeds — the
    // narrowest achievable version of the SMTP/DB crash window (ADR-017).
    await prisma.email.update({
      where: { id: emailId },
      data: {
        status: "sent",
        sentAt: new Date(),
        messageId,
        previewUrl: previewUrl || null,
      },
    });
    // Durable audit only (ADR-020) — never gates the outcome above.
    await recordRateWindowSend(claimed.senderId, now);
    return { outcome: "sent", messageId };
  } catch (err) {
    const error = describeError(err);
    await prisma.email.update({
      where: { id: emailId },
      data: { status: "failed", error },
    });
    return { outcome: "failed", error };
  }
}
