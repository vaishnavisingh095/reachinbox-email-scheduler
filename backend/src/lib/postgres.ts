import { prisma } from "./prisma";

export async function checkPostgres(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

// Node's dual-stack connection attempts (::1 and 127.0.0.1) can surface a
// connection refusal as an AggregateError with an empty top-level message —
// the real reason is in `.errors`. Unwrapping it here is what makes this
// health check's failure "a clear connection error, not a silent hang."
function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    return [...err.errors].map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}
