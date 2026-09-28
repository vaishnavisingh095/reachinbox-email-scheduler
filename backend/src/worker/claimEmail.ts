import { prisma } from "../lib/prisma";
import type { Email } from "@prisma/client";

/**
 * The atomic status claim from architecture.md's Idempotency section:
 * `UPDATE emails SET status='processing', attempts=attempts+1 WHERE
 * id=$1 AND status='scheduled' RETURNING *`. A single SQL statement, so
 * there is no window between "is this scheduled?" and "mark it
 * processing" for two concurrent deliveries of the same job to race
 * through (ADR-005). If zero rows are affected, some other execution of
 * this job already claimed it (or it isn't scheduled), and this one has
 * no work to do.
 *
 * Uses `RETURNING id` + a follow-up typed read rather than `RETURNING *`
 * purely so the result comes back through Prisma's normal camelCase
 * mapping instead of raw snake_case columns — the atomicity guarantee is
 * unchanged; the follow-up read is of a row this call already exclusively
 * owns.
 */
export async function claimEmail(emailId: string): Promise<Email | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE emails
    SET status = 'processing', attempts = attempts + 1, updated_at = now()
    WHERE id = ${emailId} AND status = 'scheduled'
    RETURNING id
  `;
  if (rows.length === 0) {
    return null;
  }
  return prisma.email.findUniqueOrThrow({ where: { id: emailId } });
}
