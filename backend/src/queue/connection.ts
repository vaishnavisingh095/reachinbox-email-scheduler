import Redis from "ioredis";
import { env } from "../config/env";

// BullMQ requires its own connection with maxRetriesPerRequest: null (it
// issues blocking commands) — this is intentionally separate from the
// `redis` client in lib/redis.ts, which is used for the health check, the
// sender min-delay lock, and the rate-limit Lua script.
export function createBullConnection() {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}
