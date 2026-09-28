import { Router } from "express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { emailQueue } from "../queue/emailQueue";
import { requireAuth } from "../middleware/authMode";
import { requireAdmin } from "../middleware/requireAdmin";

const BULL_BOARD_PATH = "/admin/queues";

/**
 * architecture.md's Bull Board section: mounted at /admin/queues, gated by
 * session + ADMIN_EMAILS. Does not touch queue semantics — read-only view
 * over the same emailQueue the worker consumes.
 */
export function mountBullBoard(): Router {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_PATH);

  createBullBoard({
    queues: [new BullMQAdapter(emailQueue)],
    serverAdapter,
  });

  const router = Router();
  router.use(requireAuth, requireAdmin, serverAdapter.getRouter());
  return router;
}

export { BULL_BOARD_PATH };
