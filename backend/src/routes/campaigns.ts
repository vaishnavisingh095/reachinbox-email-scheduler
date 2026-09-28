import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { sendError } from "../lib/httpErrors";
import { requireAuth } from "../middleware/authMode";
import { createCampaign, createCampaignSchema } from "../campaigns/createCampaign";

export const campaignsRouter = Router();

campaignsRouter.post("/", requireAuth, async (req, res) => {
  const parsed = createCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues.map((i) => i.message).join("; "));
    return;
  }

  const idempotencyKey = req.header("Idempotency-Key") || undefined;
  const result = await createCampaign(req.userId!, parsed.data, idempotencyKey);
  res.status(result.status).json(result.body);
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

async function statusCounts(campaignIds: string[]) {
  if (campaignIds.length === 0) return new Map<string, Record<string, number>>();
  const rows = await prisma.email.groupBy({
    by: ["campaignId", "status"],
    where: { campaignId: { in: campaignIds } },
    _count: { _all: true },
  });
  const map = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const entry = map.get(row.campaignId) ?? {};
    entry[row.status] = row._count._all;
    map.set(row.campaignId, entry);
  }
  return map;
}

function toCampaignSummary(
  c: {
    id: string;
    senderId: string;
    subject: string;
    startAt: Date;
    delayBetweenEmailsMs: number;
    hourlyLimit: number;
    createdAt: Date;
    sender: { email: string };
  },
  counts: Record<string, number> | undefined
) {
  const scheduled = counts?.scheduled ?? 0;
  const processing = counts?.processing ?? 0;
  const sent = counts?.sent ?? 0;
  const failed = counts?.failed ?? 0;
  return {
    id: c.id,
    sender: { id: c.senderId, email: c.sender.email },
    subject: c.subject,
    startAt: c.startAt.toISOString(),
    delayBetweenEmailsMs: c.delayBetweenEmailsMs,
    hourlyLimit: c.hourlyLimit,
    createdAt: c.createdAt.toISOString(),
    progress: {
      total: scheduled + processing + sent + failed,
      scheduled,
      processing,
      sent,
      failed,
    },
  };
}

// GET /campaigns — only the authenticated user's own campaigns, newest first.
campaignsRouter.get("/", requireAuth, async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues.map((i) => i.message).join("; "));
    return;
  }
  const { limit, offset } = parsed.data;

  const [campaigns, total] = await Promise.all([
    prisma.campaign.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: { sender: { select: { email: true } } },
    }),
    prisma.campaign.count({ where: { userId: req.userId } }),
  ]);

  const counts = await statusCounts(campaigns.map((c) => c.id));
  res.status(200).json({
    campaigns: campaigns.map((c) => toCampaignSummary(c, counts.get(c.id))),
    pagination: { limit, offset, total },
  });
});

// GET /campaigns/:id — never exposes another user's campaign: a campaign
// that exists but belongs to someone else returns 404, same as one that
// doesn't exist at all.
campaignsRouter.get("/:id", requireAuth, async (req, res) => {
  const campaign = await prisma.campaign.findUnique({
    where: { id: req.params.id },
    include: { sender: { select: { email: true } } },
  });

  if (!campaign || campaign.userId !== req.userId) {
    sendError(res, 404, "CAMPAIGN_NOT_FOUND", "No campaign with that id");
    return;
  }

  const counts = await statusCounts([campaign.id]);
  res.status(200).json(toCampaignSummary(campaign, counts.get(campaign.id)));
});
