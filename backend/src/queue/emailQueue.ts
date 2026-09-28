import { Queue } from "bullmq";
import { createBullConnection } from "./connection";

export const EMAIL_QUEUE_NAME = "email-send";

// A job's payload is minimal (an email id) — the worker always re-reads
// the row before acting (architecture.md's governing principle).
export interface EmailJobData {
  emailId: string;
}

export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
  connection: createBullConnection(),
});

/**
 * Adds (or re-adds) the delayed job for one email. Job id = email id
 * (ADR-004) — adding a job with an id already present in the queue is a
 * no-op in BullMQ, which is what makes this safe to call more than once
 * (initial scheduling, reconciliation, or a rate-limit/lock reschedule
 * after the prior job instance has completed and been removed).
 */
export async function scheduleEmailJob(emailId: string, delayMs: number) {
  return emailQueue.add(
    "send",
    { emailId },
    {
      jobId: emailId,
      delay: Math.max(0, delayMs),
      // Completed/failed jobs are removed promptly so a reschedule (a
      // fresh add with the same job id, per ADR-008) isn't blocked by a
      // leftover Redis hash from the prior instance of this job.
      removeOnComplete: true,
      removeOnFail: true,
    }
  );
}
