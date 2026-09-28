import { redis } from "../lib/redis";

// Fixed UTC hourly windows (ADR-009). Keys expire after 2 hours, per that
// ADR's stated TTL for the rate counters.
const WINDOW_TTL_SECONDS = 2 * 60 * 60;

export function getHourWindow(date: Date): string {
  // e.g. "2026-09-28T09" — matches architecture.md's documented format.
  return date.toISOString().slice(0, 13);
}

export function getNextHourStart(date: Date): Date {
  const next = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours() + 1, 0, 0, 0)
  );
  return next;
}

export function getHourStart(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), 0, 0, 0)
  );
}

// ADR-022: one atomic Lua script checks and increments BOTH the
// sender-wide safety counter and the campaign's own counter together — a
// slot is granted only if both are under their limit. Neither counter is
// touched on a refused attempt (nothing to undo).
const DUAL_RATE_LIMIT_SCRIPT = `
local senderCount   = tonumber(redis.call('GET', KEYS[1]) or '0')
local campaignCount = tonumber(redis.call('GET', KEYS[2]) or '0')
if senderCount >= tonumber(ARGV[1]) or campaignCount >= tonumber(ARGV[2]) then
  return 0
end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
`;

declare module "ioredis" {
  interface RedisCommander<Context> {
    dualRateLimit(
      senderKey: string,
      campaignKey: string,
      senderLimit: number,
      campaignLimit: number,
      ttlSeconds: number
    ): Promise<number>;
  }
}

redis.defineCommand("dualRateLimit", {
  numberOfKeys: 2,
  lua: DUAL_RATE_LIMIT_SCRIPT,
});

export interface RateLimitCheck {
  senderId: string;
  campaignId: string;
  senderLimit: number;
  campaignLimit: number;
  now: Date;
}

/** Returns true if a send slot was granted (and both counters incremented). */
export async function checkAndIncrementRateLimits({
  senderId,
  campaignId,
  senderLimit,
  campaignLimit,
  now,
}: RateLimitCheck): Promise<boolean> {
  const hourWindow = getHourWindow(now);
  const senderKey = `rate:${senderId}:${hourWindow}`;
  const campaignKey = `rate:campaign:${campaignId}:${hourWindow}`;

  const granted = await redis.dualRateLimit(senderKey, campaignKey, senderLimit, campaignLimit, WINDOW_TTL_SECONDS);
  return granted === 1;
}
