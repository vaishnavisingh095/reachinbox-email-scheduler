import nodemailer from "nodemailer";
import type { Sender, Campaign, Email } from "@prisma/client";

/**
 * Ethereal Email via Nodemailer (ADR-011). Every Ethereal test account
 * shares the same SMTP host/port — only the per-sender user/pass differ,
 * which is why senders.email / senders.ethereal_pass are the only
 * credential fields the schema stores (Phase 2).
 *
 * This module never calls nodemailer.createTestAccount() itself — it only
 * ever uses whatever credentials already exist on the sender row. Creating
 * accounts is a separate, deliberate action (ADR-011), not something the
 * send path does automatically.
 */
const ETHEREAL_SMTP_HOST = "smtp.ethereal.email";
const ETHEREAL_SMTP_PORT = 587;

function createTransport(sender: Pick<Sender, "email" | "etherealPass">) {
  return nodemailer.createTransport({
    host: ETHEREAL_SMTP_HOST,
    port: ETHEREAL_SMTP_PORT,
    secure: false,
    auth: {
      user: sender.email,
      pass: sender.etherealPass,
    },
  });
}

export interface SendResult {
  messageId: string;
  previewUrl: string | false;
}

export async function sendViaEthereal(
  sender: Pick<Sender, "email" | "etherealPass">,
  campaign: Pick<Campaign, "subject" | "body">,
  email: Pick<Email, "toEmail">
): Promise<SendResult> {
  const transport = createTransport(sender);
  const info = await transport.sendMail({
    from: sender.email,
    to: email.toEmail,
    subject: campaign.subject,
    text: campaign.body,
  });
  return {
    messageId: info.messageId,
    previewUrl: nodemailer.getTestMessageUrl(info),
  };
}
