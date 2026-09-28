// Must be imported before any route is registered — patches Express 4 to
// forward a rejected promise from an async handler into the error-handling
// middleware below, instead of the request just hanging (Express 4 does
// not do this natively; Express 5 would, but that's not what's installed).
import "express-async-errors";
import express, { type ErrorRequestHandler } from "express";
import cookieParser from "cookie-parser";
import { healthRouter } from "./routes/health";
import { campaignsRouter } from "./routes/campaigns";
import { sendersRouter } from "./routes/senders";
import { emailsRouter } from "./routes/emails";
import { authRouter } from "./routes/auth";
import { slackRouter } from "./routes/slack";
import { mountBullBoard, BULL_BOARD_PATH } from "./admin/bullBoard";
import { sendError } from "./lib/httpErrors";

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use(cookieParser());
  app.use("/health", healthRouter);
  app.use("/auth", authRouter);
  app.use("/slack", slackRouter);
  app.use("/campaigns", campaignsRouter);
  app.use("/senders", sendersRouter);
  app.use("/emails", emailsRouter);
  app.use(BULL_BOARD_PATH, mountBullBoard());

  // Final catch-all: any error that reaches here (sync throw, or an async
  // rejection forwarded by express-async-errors above) gets a clean 500,
  // logged server-side, never leaking internals (stack traces, secrets,
  // query text) to the caller.
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error("[unhandled request error]", err);
    if (res.headersSent) return;
    sendError(res, 500, "INTERNAL_ERROR", "An unexpected error occurred");
  };
  app.use(errorHandler);

  return app;
}
