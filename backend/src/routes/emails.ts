import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { sendError } from "../lib/httpErrors";
import { requireAuth } from "../middleware/authMode";
import { searchEmails } from "../search/emailIndex";

export const emailsRouter = Router();

function toEmailSummary(e: {
  id: string;
  toEmail: string;
  status: string;
  scheduledAt: Date;
  sentAt: Date | null;
  error: string | null;
  previewUrl: string | null;
  campaignId: string;
  campaign: { subject: string };
  sender: { id: string; email: string };
}) {
  return {
    id: e.id,
    toEmail: e.toEmail,
    subject: e.campaign.subject,
    sender: { id: e.sender.id, email: e.sender.email },
    status: e.status,
    scheduledAt: e.scheduledAt.toISOString(),
    sentAt: e.sentAt ? e.sentAt.toISOString() : null,
    error: e.error,
    previewUrl: e.previewUrl,
    campaignId: e.campaignId,
  };
}

const listQuerySchema = z.object({
  // architecture.md's documented API: "GET /emails?status=sent | Sent
  // list, paginated (sent/failed)" — status=sent covers both terminal
  // outcomes; status=scheduled covers only in-flight rows.
  status: z.enum(["scheduled", "sent"]),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /emails?status=scheduled|sent — only the authenticated user's own
// emails (joined through campaign ownership). Never exposes another
// user's rows.
emailsRouter.get("/", requireAuth, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues.map((i) => i.message).join("; "));
    return;
  }
  const { status, limit, offset } = parsed.data;
  const statusFilter = status === "scheduled" ? ["scheduled"] : ["sent", "failed"];

  const where = { status: { in: statusFilter as ("scheduled" | "sent" | "failed")[] }, campaign: { userId: req.userId } };

  const [emails, total] = await Promise.all([
    prisma.email.findMany({
      where,
      orderBy: status === "scheduled" ? { scheduledAt: "asc" } : { sentAt: "desc" },
      take: limit,
      skip: offset,
      include: { campaign: { select: { subject: true } }, sender: { select: { id: true, email: true } } },
    }),
    prisma.email.count({ where }),
  ]);

  res.status(200).json({
    emails: emails.map(toEmailSummary),
    pagination: { limit, offset, total },
  });
});

const searchQuerySchema = z.object({
  q: z.string().min(1, "q must not be empty"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /emails/search?q=... — Elasticsearch-backed, scoped to the
// authenticated user. An empty/missing `q` is rejected with 400 (documented
// behavior, per Phase 5's requirement to pick one and document it).
emailsRouter.get("/search", requireAuth, async (req, res) => {
  const parsed = searchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues.map((i) => i.message).join("; "));
    return;
  }
  const { q, limit, offset } = parsed.data;

  try {
    const { hits, total } = await searchEmails({ userId: req.userId!, query: q, limit, offset });
    res.status(200).json({ emails: hits, pagination: { limit, offset, total } });
  } catch (err) {
    // Elasticsearch being unreachable is a search-quality problem, not a
    // scheduling/sending one (ADR-010) — but this endpoint's only job IS
    // search, so a real ES outage surfaces as a clean 503 here rather than
    // a raw 500, without ever touching Postgres state.
    console.error("[emails/search] Elasticsearch query failed:", err);
    sendError(res, 503, "SEARCH_UNAVAILABLE", "Search is temporarily unavailable");
  }
});
