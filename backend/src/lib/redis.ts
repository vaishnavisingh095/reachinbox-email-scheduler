import Redis from "ioredis";
import { env } from "../config/env";

/**
 * ioredis is used here for the Phase 1 health check, and is the same client
 * library BullMQ (Phase 3) uses internally — so this connection isn't
 * throwaway, it's the first use of the client the rest of the system relies
 * on for job storage and the rate-limit/min-delay keys.
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  connectTimeout: 3000,
  lazyConnect: true,
});

export async function checkRedis(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (redis.status === "wait" || redis.status === "end") {
      await redis.connect();
    }
    await redis.ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
