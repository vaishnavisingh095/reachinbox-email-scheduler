/**
 * Elasticsearch backfill/reconciliation script (Phase 5). Re-indexes every
 * `sent` email from Postgres — the source of truth — into Elasticsearch.
 * Run this after an Elasticsearch outage, or any time the index needs to
 * catch up, instead of making the worker's hot send path retry indexing
 * inline (architecture.md's Elasticsearch section calls for exactly this
 * shape of catch-up mechanism).
 *
 * Usage: tsx scripts/backfill-elasticsearch.ts
 */
import "../src/config/env";
import { prisma } from "../src/lib/prisma";
import { indexEmail } from "../src/search/emailIndex";

async function main() {
  const emails = await prisma.email.findMany({
    where: { status: "sent" },
    include: { campaign: true, sender: true },
  });

  console.log(`Backfilling ${emails.length} sent emails into Elasticsearch...`);

  let ok = 0;
  for (const email of emails) {
    await indexEmail(email, email.campaign, email.sender);
    ok += 1;
  }

  console.log(`Done: ${ok}/${emails.length} indexed (failures are logged individually and swallowed).`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
