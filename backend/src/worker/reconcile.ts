import { prisma } from "../lib/prisma";
import { emailQueue, scheduleEmailJob } from "../queue/emailQueue";

// "e.g. 10 minutes — far longer than a send should ever take"
// (architecture.md's Persistence and restart recovery section).
const PROCESSING_STUCK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Runs once at worker boot, before any new jobs are consumed
 * (architecture.md's "Worker restart" section). Keys off Postgres, not
 * Redis's view of the world, so this is correct even if Redis itself was
 * wiped: every `scheduled` row with no matching job gets a fresh one.
 */
export async function reconcile(): Promise<{ reenqueued: number; recovered: number; ambiguous: number }> {
  let reenqueued = 0;
  let recovered = 0;
  let ambiguous = 0;

  // 1. Scheduled rows without a live BullMQ job.
  const scheduledRows = await prisma.email.findMany({ where: { status: "scheduled" } });
  for (const row of scheduledRows) {
    const existingJob = await emailQueue.getJob(row.id);
    if (existingJob) {
      continue;
    }
    const delayMs = row.scheduledAt.getTime() - Date.now();
    await scheduleEmailJob(row.id, delayMs);
    if (row.jobId !== row.id) {
      await prisma.email.update({ where: { id: row.id }, data: { jobId: row.id } });
    }
    reenqueued += 1;
    console.log(`[reconcile] re-enqueued missing job for email ${row.id} (delay ${Math.max(0, delayMs)}ms)`);
  }

  // 2. Stuck `processing` rows — a worker died mid-send.
  const stuckThreshold = new Date(Date.now() - PROCESSING_STUCK_TIMEOUT_MS);
  const stuckRows = await prisma.email.findMany({
    where: { status: "processing", updatedAt: { lt: stuckThreshold } },
  });
  for (const row of stuckRows) {
    if (row.messageId) {
      // ADR-017: message_id present but status never reached 'sent' means
      // the send may have completed before the crash — resending risks a
      // real duplicate. This is logged for manual review, not auto-resolved
      // in either direction.
      ambiguous += 1;
      console.error(
        `[reconcile] AMBIGUOUS delivery for email ${row.id}: stuck in 'processing' since ${row.updatedAt.toISOString()} ` +
          `with message_id=${row.messageId} already set. The send may have completed before a crash prevented the ` +
          `status write. Not auto-resent — needs manual review (check Ethereal's own log for this message).`
      );
      continue;
    }
    // No message_id: the send itself likely never completed — safe to retry.
    await prisma.email.update({
      where: { id: row.id },
      data: { status: "scheduled", scheduledAt: new Date() },
    });
    recovered += 1;
    console.log(`[reconcile] recovered stuck email ${row.id} (no message_id) — moved back to scheduled`);
  }

  // Stuck rows just moved back to `scheduled` above get their job
  // (re-)created here, in the same pass that already handles that case.
  if (recovered > 0) {
    const recoveredRows = await prisma.email.findMany({
      where: { status: "scheduled", id: { in: stuckRows.filter((r) => !r.messageId).map((r) => r.id) } },
    });
    for (const row of recoveredRows) {
      const existingJob = await emailQueue.getJob(row.id);
      if (existingJob) continue;
      await scheduleEmailJob(row.id, row.scheduledAt.getTime() - Date.now());
      if (row.jobId !== row.id) {
        await prisma.email.update({ where: { id: row.id }, data: { jobId: row.id } });
      }
    }
  }

  console.log(
    `[reconcile] done: re-enqueued=${reenqueued}, recovered-stuck=${recovered}, ambiguous=${ambiguous}`
  );
  return { reenqueued, recovered, ambiguous };
}
