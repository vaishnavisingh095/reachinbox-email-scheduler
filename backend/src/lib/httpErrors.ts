import type { Response } from "express";

// The one JSON error shape used everywhere in the API (architecture.md's
// API architecture section: `{ error: { code, message } }`).
export function sendError(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}
