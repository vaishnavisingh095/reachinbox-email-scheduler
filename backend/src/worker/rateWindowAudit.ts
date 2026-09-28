import { prisma } from "../lib/prisma";
import { getHourStart } from "../queue/rateLimit";

/**
 * ADR-020: durable audit only, strictly downstream of the Redis check —
 * never gates or re-decides a send. Called after a successful send; a
 * failure here is logged and must never roll back the `sent` status write,
 * trigger a resend, or affect the Redis counter.
 */
export async function recordRateWindowSend(senderId: string, sentAt: Date): Promise<void> {
  const windowStart = getHourStart(sentAt);
  try {
    await prisma.rateWindow.upsert({
      where: { senderId_windowStart: { senderId, windowStart } },
      create: { senderId, windowStart, count: 1 },
      update: { count: { increment: 1 } },
    });
  } catch (err) {
    console.error(
      `[rate_windows] failed to record audit write for sender=${senderId} window=${windowStart.toISOString()}:`,
      err
    );
  }
}
