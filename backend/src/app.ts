import express from "express";
import { healthRouter } from "./routes/health";
import { campaignsRouter } from "./routes/campaigns";

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use("/health", healthRouter);
  app.use("/campaigns", campaignsRouter);

  return app;
}
