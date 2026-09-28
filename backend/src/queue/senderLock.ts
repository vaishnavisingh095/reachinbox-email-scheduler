import { redis } from "../lib/redis";
import { env } from "../config/env";

/**
 * Per-sender Redis lock (ADR-006): `SET lock:sender:{senderId} <val> NX PX
 * <MIN_DELAY_MS>`. Visible to every worker process and every concurrent
 * job slot, unlike an in-process delay — this is what makes the minimum
 * spacing guarantee hold across the whole system, not just one worker.
 */
export async function acquireSenderLock(senderId: string): Promise<boolean> {
  const key = `lock:sender:${senderId}`;
  const result = await redis.set(key, "1", "PX", env.MIN_DELAY_MS, "NX");
  return result === "OK";
}
