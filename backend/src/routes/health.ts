import { Router } from "express";
import { checkPostgres } from "../lib/postgres";
import { checkRedis } from "../lib/redis";

export const healthRouter = Router();

/**
 * Per docs/plan.md Phase 1: returns 200 once the API can reach Postgres and
 * Redis. Elasticsearch is intentionally not checked here — ADR-010 treats
 * it as a derived, best-effort component whose unavailability must never
 * affect the core sending/scheduling path, and a health check that failed
 * because of it would contradict that.
 */
healthRouter.get("/", async (_req, res) => {
  const [postgres, redisResult] = await Promise.all([checkPostgres(), checkRedis()]);

  const healthy = postgres.ok && redisResult.ok;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "unhealthy",
    checks: {
      postgres,
      redis: redisResult,
    },
    timestamp: new Date().toISOString(),
  });
});
