import { Pool } from "pg";
import { env } from "../config/env";

/**
 * A raw `pg` pool, used only for the Phase 1 health check. Prisma (Phase 2)
 * becomes the real data-access layer; this file is not where application
 * queries will live once Prisma is introduced.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
});

export async function checkPostgres(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await pool.query("SELECT 1");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

// Node's dual-stack connection attempts (::1 and 127.0.0.1) surface a
// connection refusal as an AggregateError with an empty top-level message —
// the real reason is in `.errors`. Unwrapping it here is what makes this
// health check's failure "a clear connection error, not a silent hang."
function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    return [...err.errors].map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}
