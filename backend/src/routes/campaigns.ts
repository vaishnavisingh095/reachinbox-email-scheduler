import { Router } from "express";
import { devAuth } from "../middleware/devAuth";
import { createCampaign, createCampaignSchema } from "../campaigns/createCampaign";

export const campaignsRouter = Router();

campaignsRouter.post("/", devAuth, async (req, res) => {
  const parsed = createCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: parsed.error.issues.map((i) => i.message).join("; ") },
    });
    return;
  }

  const idempotencyKey = req.header("Idempotency-Key") || undefined;
  const result = await createCampaign(req.userId!, parsed.data, idempotencyKey);
  res.status(result.status).json(result.body);
});
