import { Router } from "express";
import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import { env } from "../config/env";
import { getHourWindow } from "../queue/rateLimit";
import { requireAuth } from "../middleware/authMode";

export const sendersRouter = Router();

// GET /senders — only the authenticated user's own senders (ADR-019). No
// implicit/default sender is introduced here or anywhere else.
sendersRouter.get("/", requireAuth, async (req, res) => {
  const senders = await prisma.sender.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, createdAt: true },
  });

  const hourWindow = getHourWindow(new Date());
  const withUsage = await Promise.all(
    senders.map(async (sender) => {
      const used = Number((await redis.get(`rate:${sender.id}:${hourWindow}`)) ?? 0);
      return {
        id: sender.id,
        email: sender.email,
        createdAt: sender.createdAt.toISOString(),
        currentHourUsage: { used, limit: env.MAX_EMAILS_PER_HOUR_PER_SENDER },
      };
    })
  );

  res.status(200).json({ senders: withUsage });
});
