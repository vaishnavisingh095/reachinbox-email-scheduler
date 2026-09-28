/**
 * Throwaway Phase 3 test script (per docs/plan.md's Phase 3 description) —
 * not part of the application's real API surface. Inserts one email row
 * against an existing seeded campaign/sender and enqueues its BullMQ job,
 * for exercising the scheduling pipeline end to end before Phase 6 builds
 * the real POST /campaigns endpoint.
 *
 * Usage: tsx scripts/schedule-test-email.ts [delaySeconds] [toEmail] [campaignSubject]
 */
import "../src/config/env";
import { prisma } from "../src/lib/prisma";
import { emailQueue, scheduleEmailJob } from "../src/queue/emailQueue";

async function main() {
  const delaySeconds = Number(process.argv[2] ?? 30);
  const toEmail = process.argv[3] ?? `test-${Date.now()}@example.com`;
  const campaignSubject = process.argv[4] ?? "Welcome to ReachInbox";

  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { subject: campaignSubject },
  });

  const scheduledAt = new Date(Date.now() + delaySeconds * 1000);

  const email = await prisma.email.create({
    data: {
      campaignId: campaign.id,
      senderId: campaign.senderId,
      toEmail,
      scheduledAt,
      status: "scheduled",
    },
  });

  await scheduleEmailJob(email.id, scheduledAt.getTime() - Date.now());
  await prisma.email.update({ where: { id: email.id }, data: { jobId: email.id } });

  console.log(`Scheduled email ${email.id} for ${toEmail} at ${scheduledAt.toISOString()} (+${delaySeconds}s)`);
  console.log(`campaignId=${campaign.id} senderId=${campaign.senderId}`);

  await prisma.$disconnect();
  await emailQueue.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
