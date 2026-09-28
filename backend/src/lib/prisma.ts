import { PrismaClient } from "@prisma/client";

// A single shared client for the whole process — architecture.md describes
// Prisma as "the typed data-access layer over Postgres, used identically
// by the API and the worker process," not a per-request or per-module
// instance.
export const prisma = new PrismaClient();
