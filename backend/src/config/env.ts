import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

// The monorepo's single .env lives at the repo root, one level above
// backend/ — resolved from this file's own location so it doesn't depend
// on the process's working directory (npm workspace scripts run with cwd
// set to backend/, not the repo root).
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

/**
 * Every variable here is exactly the documented list in
 * docs/architecture.md's "Environment variables" section — that document
 * states no additional variables are introduced beyond it. Presence is
 * validated for all of them starting now (Phase 1), even though several
 * (Google/Slack secrets, SESSION_SECRET, ADMIN_EMAILS) aren't consumed by
 * any code until their respective phases land — this keeps one schema that
 * matches the doc exactly, rather than one that grows piecemeal per phase.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  ELASTICSEARCH_URL: z.string().min(1, "ELASTICSEARCH_URL is required"),

  WORKER_CONCURRENCY: z.coerce.number().int().positive(),
  MIN_DELAY_MS: z.coerce.number().int().positive(),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().positive(),

  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),

  SLACK_CLIENT_ID: z.string().min(1, "SLACK_CLIENT_ID is required"),
  SLACK_CLIENT_SECRET: z.string().min(1, "SLACK_CLIENT_SECRET is required"),

  // Signs session cookies (ADR-012) and Slack OAuth state tokens (lib/slack.ts)
  // — a short or default value would let anyone forge a valid session for
  // any user id. The literal .env.example placeholder is checked explicitly
  // because it's a public, well-known string (33 chars — long enough to
  // slip past a plain length check) committed in this very repo; deploying
  // without changing it is a real, realistic misconfiguration, not a
  // hypothetical one.
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters — it signs session cookies; a short value is forgeable")
    .refine(
      (v) => v !== "change-me-to-a-long-random-string",
      "SESSION_SECRET is still set to the .env.example placeholder — sessions would be forgeable by anyone who has read this repo. Set a real random secret."
    ),
  ADMIN_EMAILS: z.string().min(1, "ADMIN_EMAILS is required"),

  FRONTEND_URL: z.string().min(1, "FRONTEND_URL is required"),
  API_URL: z.string().min(1, "API_URL is required"),

  // Not part of architecture.md's documented list — a standard Node.js
  // runtime convention, not an application-architecture variable, so it's
  // optional with a sane default rather than a required, documented var.
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error("Invalid or missing environment variables:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    console.error(
      "\nCopy .env.example to .env and fill in the missing values, then retry."
    );
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

/**
 * architecture.md's documented variable list has no PORT variable — the
 * API's own listen port is derived from API_URL instead of introducing an
 * additional variable beyond that list.
 */
export function getApiPort(): number {
  try {
    const url = new URL(env.API_URL);
    if (url.port) return Number(url.port);
  } catch {
    // fall through to default below
  }
  return 4000;
}
