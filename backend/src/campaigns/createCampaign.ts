import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { emailQueue } from "../queue/emailQueue";

// Matches architecture.md's documented POST /campaigns shape: senderId is
// required (ADR-019 — no implicit default sender); startAt/
// delayBetweenEmailsMs/hourlyLimit are optional overrides of the
// MIN_DELAY_MS / MAX_EMAILS_PER_HOUR_PER_SENDER defaults (ADR-021/022).
export const createCampaignSchema = z.object({
  senderId: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
  recipients: z.array(z.string().email()).min(1),
  startAt: z.coerce.date().optional(),
  delayBetweenEmailsMs: z.coerce.number().int().positive().optional(),
  hourlyLimit: z.coerce.number().int().positive().optional(),
});

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

export interface CampaignResponseBody {
  campaign: {
    id: string;
    senderId: string;
    subject: string;
    body: string;
    startAt: string;
    delayBetweenEmailsMs: number;
    hourlyLimit: number;
  };
  emails: { id: string; toEmail: string; scheduledAt: string }[];
}

export type CreateCampaignResult =
  | { status: 201; body: CampaignResponseBody }
  | { status: 200; body: CampaignResponseBody }
  | { status: 400; body: { error: { code: string; message: string } } }
  | { status: 403; body: { error: { code: string; message: string } } }
  | { status: 409; body: { error: { code: string; message: string } } };

/**
 * architecture.md's Scheduling architecture section, implemented as
 * literally as possible:
 *
 *   look up Idempotency-Key -> validate sender ownership -> resolve
 *   scheduling controls -> one transaction (campaign + emails) -> addBulk
 *   -> record the response in idempotency_keys
 */
export async function createCampaign(
  userId: string,
  input: CreateCampaignInput,
  idempotencyKey: string | undefined
): Promise<CreateCampaignResult> {
  const recipients = dedupeCaseInsensitive(input.recipients);
  if (recipients.length !== input.recipients.length) {
    return {
      status: 400,
      body: { error: { code: "DUPLICATE_RECIPIENT", message: "recipients contains duplicate addresses" } },
    };
  }

  if (idempotencyKey) {
    const existing = await prisma.idempotencyKey.findUnique({
      where: { userId_key: { userId, key: idempotencyKey } },
    });
    if (existing) {
      return checkIdempotentReplay(existing, userId, input, recipients);
    }
  }

  const sender = await prisma.sender.findUnique({ where: { id: input.senderId } });
  if (!sender || sender.userId !== userId) {
    return {
      status: 403,
      body: { error: { code: "SENDER_NOT_OWNED", message: "senderId does not belong to the authenticated user" } },
    };
  }

  const startAt = input.startAt ?? new Date();
  const delayBetweenEmailsMs = input.delayBetweenEmailsMs ?? env.MIN_DELAY_MS;
  const hourlyLimit = input.hourlyLimit ?? env.MAX_EMAILS_PER_HOUR_PER_SENDER;

  // Campaign id (like each email's id) is generated client-side, before the
  // transaction, so the full response — including the idempotency-key
  // row's response_body — can be built up front and reused for both the
  // success path and a lost-race replay.
  const campaignId = randomUUID();
  const emailRows = recipients.map((toEmail, position) => ({
    id: randomUUID(),
    toEmail,
    scheduledAt: new Date(startAt.getTime() + position * delayBetweenEmailsMs),
  }));

  const responseBody: CampaignResponseBody = {
    campaign: {
      id: campaignId,
      senderId: input.senderId,
      subject: input.subject,
      body: input.body,
      startAt: startAt.toISOString(),
      delayBetweenEmailsMs,
      hourlyLimit,
    },
    emails: emailRows.map((row) => ({
      id: row.id,
      toEmail: row.toEmail,
      scheduledAt: row.scheduledAt.toISOString(),
    })),
  };

  try {
    // Campaign + emails + (if provided) the idempotency-key claim all
    // commit together, atomically. The idempotency_keys(user_id, key)
    // unique constraint is what actually serializes two concurrent
    // identical requests: Postgres blocks the second transaction's INSERT
    // on the first's uncommitted row-level lock on that index entry, then
    // either lets it through (first rolled back) or fails it cleanly
    // (first committed) — real database-native serialization, not an
    // application-level lock. Because everything is one transaction, a
    // failure here rolls the campaign and emails back too, so the loser
    // never commits a campaign at all, and addBulk (below, strictly after
    // commit) never runs for it.
    await prisma.$transaction(async (tx) => {
      await tx.campaign.create({
        data: {
          id: campaignId,
          userId,
          senderId: input.senderId,
          subject: input.subject,
          body: input.body,
          startAt,
          delayBetweenEmailsMs,
          hourlyLimit,
        },
      });
      await tx.email.createMany({
        data: emailRows.map((row) => ({
          id: row.id,
          campaignId,
          senderId: input.senderId,
          toEmail: row.toEmail,
          scheduledAt: row.scheduledAt,
          status: "scheduled",
        })),
      });
      if (idempotencyKey) {
        await tx.idempotencyKey.create({
          data: { userId, key: idempotencyKey, campaignId, responseBody: responseBody as object },
        });
      }
    });
  } catch (err) {
    // The only unique constraint this transaction can hit is
    // idempotency_keys(user_id, key) — campaignId/email ids are fresh
    // UUIDs, and emails(campaign_id, to_email) can't collide against a
    // campaign_id that didn't exist before this call. So: idempotencyKey
    // was provided (nothing else could conflict) and Prisma reports a
    // unique violation => we lost the race, not a real error.
    if (idempotencyKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.idempotencyKey.findUniqueOrThrow({
        where: { userId_key: { userId, key: idempotencyKey } },
      });
      return checkIdempotentReplay(existing, userId, input, recipients);
    }
    throw err;
  }

  // Rows are committed (including the idempotency claim) before jobs are
  // enqueued (architecture.md's Scheduling architecture section) — an
  // addBulk failure here leaves `scheduled` rows with job_id still null,
  // which boot-time reconciliation will pick up and re-enqueue.
  await emailQueue.addBulk(
    emailRows.map((row) => ({
      name: "send",
      data: { emailId: row.id },
      opts: {
        jobId: row.id,
        delay: Math.max(0, row.scheduledAt.getTime() - Date.now()),
        removeOnComplete: true,
        removeOnFail: true,
      },
    }))
  );

  await prisma.$executeRaw`
    UPDATE emails SET job_id = id
    WHERE campaign_id = ${campaignId} AND job_id IS NULL
  `;

  return { status: 201, body: responseBody };
}

function dedupeCaseInsensitive(recipients: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const r of recipients) {
    const key = r.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(r);
    }
  }
  return result;
}

/**
 * Same (user_id, key): must not create a second campaign. Compares the
 * retry's request against the campaign the original request actually
 * created (idempotency_keys has no separate request-fingerprint column —
 * ADR-018 didn't call for one, and the campaign row itself already *is*
 * the ground truth of what the original request produced, so comparing
 * against it directly avoids a schema change).
 *
 * `startAt` is deliberately excluded from the comparison: when a client
 * omits it, it defaults to "now" on every call, so two legitimate retries
 * of the same logical request would otherwise almost always mismatch on
 * that field alone. Every other field is compared against the resolved,
 * persisted value.
 */
async function checkIdempotentReplay(
  existing: { campaignId: string; responseBody: unknown },
  userId: string,
  input: CreateCampaignInput,
  recipients: string[]
): Promise<CreateCampaignResult> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: existing.campaignId },
    include: { emails: { select: { toEmail: true } } },
  });

  if (!campaign || campaign.userId !== userId) {
    // Should be unreachable (idempotency_keys.user_id already scopes this),
    // but fail closed rather than replaying someone else's response.
    return {
      status: 409,
      body: { error: { code: "IDEMPOTENCY_KEY_CONFLICT", message: "stored campaign for this key is inaccessible" } },
    };
  }

  const storedRecipients = new Set(campaign.emails.map((e) => e.toEmail.toLowerCase()));
  const requestRecipients = new Set(recipients.map((r) => r.toLowerCase()));
  const sameRecipients =
    storedRecipients.size === requestRecipients.size && [...storedRecipients].every((r) => requestRecipients.has(r));

  const matches =
    campaign.senderId === input.senderId &&
    campaign.subject === input.subject &&
    campaign.body === input.body &&
    (input.delayBetweenEmailsMs === undefined || campaign.delayBetweenEmailsMs === input.delayBetweenEmailsMs) &&
    (input.hourlyLimit === undefined || campaign.hourlyLimit === input.hourlyLimit) &&
    sameRecipients;

  if (!matches) {
    return {
      status: 409,
      body: {
        error: {
          code: "IDEMPOTENCY_KEY_CONFLICT",
          message: "This Idempotency-Key was already used with different request data.",
        },
      },
    };
  }

  return { status: 200, body: existing.responseBody as CampaignResponseBody };
}
