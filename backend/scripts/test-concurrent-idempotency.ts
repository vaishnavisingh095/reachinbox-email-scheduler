/**
 * Focused regression test for the createCampaign.ts concurrency fix.
 * Fires two genuinely concurrent POST /campaigns requests with the same
 * (userId, Idempotency-Key) and identical bodies, then asserts:
 *   - exactly one campaign was created
 *   - exactly one idempotency_keys row exists for that key
 *   - exactly N email rows exist (not 2N)
 *   - both responses agree on the same campaign id
 *
 * Requires the API server running on API_URL (default http://localhost:4000)
 * and a seeded database (npm run db:seed).
 *
 * Usage: tsx scripts/test-concurrent-idempotency.ts
 */
import "../src/config/env";
import { prisma } from "../src/lib/prisma";

const API_URL = process.env.API_URL_OVERRIDE || "http://localhost:4000";

async function main() {
  const user = await prisma.user.findFirstOrThrow({ where: { email: "dev1@example.com" } });
  const sender = await prisma.sender.findFirstOrThrow({ where: { userId: user.id } });
  const key = `concurrency-test-${Date.now()}`;
  const recipients = ["c1@example.com", "c2@example.com", "c3@example.com"];

  const body = JSON.stringify({
    senderId: sender.id,
    subject: "Concurrency Test",
    body: "test",
    recipients,
  });

  const request = () =>
    fetch(`${API_URL}/campaigns`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Dev-User-Id": user.id,
        "Idempotency-Key": key,
      },
      body,
    }).then(async (res) => ({ status: res.status, json: (await res.json()) as Record<string, any> }));

  console.log(`Firing two concurrent POST /campaigns with Idempotency-Key=${key} ...`);
  const [a, b] = await Promise.all([request(), request()]);

  console.log("Response A:", a.status, JSON.stringify(a.json).slice(0, 150));
  console.log("Response B:", b.status, JSON.stringify(b.json).slice(0, 150));

  const failures: string[] = [];

  const statuses = [a.status, b.status].sort();
  if (JSON.stringify(statuses) !== JSON.stringify([200, 201])) {
    failures.push(`Expected one 201 and one 200, got ${statuses.join(",")}`);
  }

  const idA = a.json?.campaign?.id ?? a.json?.error;
  const idB = b.json?.campaign?.id ?? b.json?.error;
  if (idA !== idB) {
    failures.push(`Responses disagree on campaign id: A=${idA} B=${idB}`);
  }

  const campaignId = a.json?.campaign?.id;
  const campaignCount = await prisma.campaign.count({ where: { id: campaignId } });
  if (campaignCount !== 1) failures.push(`Expected exactly 1 campaign, found ${campaignCount}`);

  const keyCount = await prisma.idempotencyKey.count({ where: { userId: user.id, key } });
  if (keyCount !== 1) failures.push(`Expected exactly 1 idempotency_keys row, found ${keyCount}`);

  const emailCount = await prisma.email.count({ where: { campaignId } });
  if (emailCount !== recipients.length) {
    failures.push(`Expected exactly ${recipients.length} email rows, found ${emailCount}`);
  }

  await prisma.$disconnect();

  if (failures.length > 0) {
    console.error("\nFAIL:");
    failures.forEach((f) => console.error("  - " + f));
    process.exit(1);
  }

  console.log("\nPASS: exactly one campaign, one idempotency_keys row, and " + recipients.length + " email rows.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
