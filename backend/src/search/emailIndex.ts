import type { estypes } from "@elastic/elasticsearch";
import { esClient } from "./esClient";
import type { Email, Campaign, Sender } from "@prisma/client";

export const EMAIL_INDEX = "emails";

/**
 * userId is not part of architecture.md's originally-documented ES field
 * list (to_email/subject/body/status/scheduled_at/sent_at/sender) — it's
 * added here because search results "must be scoped to the authenticated
 * user" (Phase 5) and the original design predates that requirement having
 * a concrete API. It's a filter field, not a search field.
 */
export async function ensureEmailIndex(): Promise<void> {
  const exists = await esClient.indices.exists({ index: EMAIL_INDEX });
  if (exists) return;

  await esClient.indices.create({
    index: EMAIL_INDEX,
    mappings: {
      properties: {
        toEmail: { type: "text" },
        subject: { type: "text" },
        body: { type: "text" },
        sender: { type: "text" },
        status: { type: "keyword" },
        scheduledAt: { type: "date" },
        sentAt: { type: "date" },
        campaignId: { type: "keyword" },
        userId: { type: "keyword" },
      },
    },
  });
}

export interface EmailIndexDoc {
  toEmail: string;
  subject: string;
  body: string;
  sender: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  campaignId: string;
  userId: string;
}

/**
 * Failure isolation (ADR-010, architecture.md's Elasticsearch section):
 * logs and swallows every error. Must never throw — nothing that calls
 * this is allowed to have its own outcome affected by an ES problem.
 * Document id = the email's Postgres id, so a repeat call for the same
 * email overwrites rather than duplicating (architecture.md: "this makes
 * every write to the index idempotent").
 */
export async function indexEmail(
  email: Pick<Email, "id" | "toEmail" | "status" | "scheduledAt" | "sentAt" | "campaignId">,
  campaign: Pick<Campaign, "subject" | "body" | "userId">,
  sender: Pick<Sender, "email">
): Promise<void> {
  const doc: EmailIndexDoc = {
    toEmail: email.toEmail,
    subject: campaign.subject,
    body: campaign.body,
    sender: sender.email,
    status: email.status,
    scheduledAt: email.scheduledAt.toISOString(),
    sentAt: email.sentAt ? email.sentAt.toISOString() : null,
    campaignId: email.campaignId,
    userId: campaign.userId,
  };

  try {
    await ensureEmailIndex();
    await esClient.index({ index: EMAIL_INDEX, id: email.id, document: doc });
  } catch (err) {
    console.error(`[elasticsearch] failed to index email ${email.id}:`, err);
  }
}

export interface SearchParams {
  userId: string;
  query: string;
  limit: number;
  offset: number;
}

export interface SearchHit {
  id: string;
  toEmail: string;
  subject: string;
  sender: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  campaignId: string;
}

export async function searchEmails({ userId, query, limit, offset }: SearchParams): Promise<{
  hits: SearchHit[];
  total: number;
}> {
  await ensureEmailIndex();

  // `@elastic/elasticsearch@8.19.2`'s own bundled QueryDslBoolQuery type
  // definition fails to typecheck against a plain, valid bool query object
  // (reproduced in complete isolation, outside this codebase, with no
  // fields involved beyond filter/must) — a confirmed upstream typings
  // defect, not a real type error here. The query below is standard
  // Elasticsearch DSL; the cast only bypasses the broken .d.ts, not any
  // actual type safety this project controls.
  const boolQuery = {
    bool: {
      filter: [{ term: { userId } }],
      must: [
        {
          multi_match: {
            query,
            fields: ["toEmail", "subject", "body", "sender"],
          },
        },
      ],
    },
  } as unknown as estypes.QueryDslQueryContainer;

  const result = await esClient.search<EmailIndexDoc>({
    index: EMAIL_INDEX,
    from: offset,
    size: limit,
    query: boolQuery,
  });

  const hits = result.hits.hits.map((h) => {
    const source = h._source as EmailIndexDoc;
    return {
      id: h._id as string,
      toEmail: source.toEmail,
      subject: source.subject,
      sender: source.sender,
      status: source.status,
      scheduledAt: source.scheduledAt,
      sentAt: source.sentAt,
      campaignId: source.campaignId,
    };
  });

  const total = typeof result.hits.total === "number" ? result.hits.total : (result.hits.total?.value ?? hits.length);

  return { hits, total };
}
