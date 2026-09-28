import { Worker, type Job } from "bullmq";
import { env } from "./config/env";
import { createBullConnection } from "./queue/connection";
import { EMAIL_QUEUE_NAME, scheduleEmailJob, type EmailJobData } from "./queue/emailQueue";
import { processEmail, type ProcessResult } from "./worker/processEmail";
import { reconcile } from "./worker/reconcile";

async function main() {
  console.log("[worker] starting boot-time reconciliation...");
  await reconcile();

  // autorun: false — no new jobs are consumed until reconciliation above
  // has completed (architecture.md's "Worker restart" section).
  const worker = new Worker<EmailJobData, ProcessResult>(
    EMAIL_QUEUE_NAME,
    async (job: Job<EmailJobData>) => processEmail(job.data.emailId),
    {
      connection: createBullConnection(),
      concurrency: env.WORKER_CONCURRENCY,
      autorun: false,
    }
  );

  // A rate-limit/lock reschedule completes the *current* job instance
  // (the Postgres row already reflects the new scheduled_at) and creates a
  // fresh delayed job with the same id (ADR-004, ADR-008) — done here,
  // after BullMQ has fully finished this job instance, so the job id is
  // free to reuse (see emailQueue.ts's removeOnComplete).
  worker.on("completed", async (job, result: ProcessResult) => {
    if (result.outcome === "rescheduled") {
      const delayMs = new Date(result.scheduledAt).getTime() - Date.now();
      await scheduleEmailJob(job.data.emailId, delayMs);
      console.log(
        `[worker] rescheduled email ${job.data.emailId} (${result.reason}) -> ${result.scheduledAt}`
      );
    } else if (result.outcome === "sent") {
      console.log(`[worker] sent email ${job.data.emailId} (message_id=${result.messageId})`);
    } else if (result.outcome === "failed") {
      console.error(`[worker] failed email ${job.data.emailId}: ${result.error}`);
    } else {
      console.log(`[worker] skipped email ${job.data.emailId}: ${result.reason}`);
    }
  });

  worker.on("error", (err) => {
    console.error("[worker] error:", err);
  });

  await worker.run();
  console.log(`[worker] running with concurrency=${env.WORKER_CONCURRENCY}`);
}

main().catch((err) => {
  console.error("[worker] fatal error during startup:", err);
  process.exit(1);
});
