import "../src/config/env";
import { prisma } from "../src/lib/prisma";

// Development seed data only. Sender credentials below are placeholders,
// not real Ethereal accounts — creating real ones (nodemailer's
// createTestAccount()) is Phase 3/ADR-011 territory, not Phase 2. The
// `.invalid` TLD (RFC 2606) makes that unambiguous.

async function main() {
  // Clean slate, children before parents, so this script is safely
  // re-runnable during development.
  await prisma.idempotencyKey.deleteMany();
  await prisma.email.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.rateWindow.deleteMany();
  await prisma.slackConnection.deleteMany();
  await prisma.sender.deleteMany();
  await prisma.user.deleteMany();

  const userOne = await prisma.user.create({
    data: {
      googleId: "dev-google-id-1",
      email: "dev1@example.com",
      name: "Ada Lovelace",
      avatarUrl: null,
    },
  });

  const userTwo = await prisma.user.create({
    data: {
      googleId: "dev-google-id-2",
      email: "dev2@example.com",
      name: "Alan Turing",
      avatarUrl: null,
    },
  });

  const senderA = await prisma.sender.create({
    data: {
      userId: userOne.id,
      email: "sender-a@ethereal.invalid",
      etherealPass: "dev-placeholder-pass-a",
    },
  });

  const senderB = await prisma.sender.create({
    data: {
      userId: userOne.id,
      email: "sender-b@ethereal.invalid",
      etherealPass: "dev-placeholder-pass-b",
    },
  });

  const senderC = await prisma.sender.create({
    data: {
      userId: userTwo.id,
      email: "sender-c@ethereal.invalid",
      etherealPass: "dev-placeholder-pass-c",
    },
  });

  const now = new Date();

  // Mirrors architecture.md's Hourly rate limiting worked example directly:
  // sender A has two campaigns (50/hour, 100/hour) that together must never
  // exceed a 200/hour sender-wide safety cap (ADR-022).
  const campaignOne = await prisma.campaign.create({
    data: {
      userId: userOne.id,
      senderId: senderA.id,
      subject: "Welcome to ReachInbox",
      body: "Hello — this is seed data for campaign 1.",
      startAt: now,
      delayBetweenEmailsMs: 2000,
      hourlyLimit: 50,
    },
  });

  const campaignTwo = await prisma.campaign.create({
    data: {
      userId: userOne.id,
      senderId: senderA.id,
      subject: "Product Update",
      body: "Hello — this is seed data for campaign 2.",
      startAt: now,
      delayBetweenEmailsMs: 5000,
      hourlyLimit: 100,
    },
  });

  // A second sender for the same user, and a third sender for a different
  // user entirely — both using the env-var defaults, to exercise
  // multi-sender and multi-user isolation.
  const campaignThree = await prisma.campaign.create({
    data: {
      userId: userOne.id,
      senderId: senderB.id,
      subject: "Newsletter",
      body: "Hello — this is seed data for campaign 3 (sender B).",
      startAt: now,
      delayBetweenEmailsMs: 2000,
      hourlyLimit: 200,
    },
  });

  const campaignFour = await prisma.campaign.create({
    data: {
      userId: userTwo.id,
      senderId: senderC.id,
      subject: "Getting Started",
      body: "Hello — this is seed data for campaign 4 (sender C, user 2).",
      startAt: now,
      delayBetweenEmailsMs: 2000,
      hourlyLimit: 200,
    },
  });

  // Per campaign's scheduling controls (ADR-021): scheduled_at = start_at +
  // (ordinal position * delay_between_emails_ms).
  function scheduledAtFor(campaign: { startAt: Date; delayBetweenEmailsMs: number }, position: number) {
    return new Date(campaign.startAt.getTime() + position * campaign.delayBetweenEmailsMs);
  }

  await prisma.email.createMany({
    data: [
      // campaignOne: still scheduled, none sent yet.
      {
        campaignId: campaignOne.id,
        senderId: senderA.id,
        toEmail: "recipient1@example.com",
        scheduledAt: scheduledAtFor(campaignOne, 0),
        status: "scheduled",
      },
      {
        campaignId: campaignOne.id,
        senderId: senderA.id,
        toEmail: "recipient2@example.com",
        scheduledAt: scheduledAtFor(campaignOne, 1),
        status: "scheduled",
      },
      {
        campaignId: campaignOne.id,
        senderId: senderA.id,
        toEmail: "recipient3@example.com",
        scheduledAt: scheduledAtFor(campaignOne, 2),
        status: "scheduled",
      },
      // campaignTwo: a mix of statuses, for exercising the Sent table and
      // failure-isolation paths in later phases without running a worker.
      {
        campaignId: campaignTwo.id,
        senderId: senderA.id,
        toEmail: "recipient4@example.com",
        scheduledAt: scheduledAtFor(campaignTwo, 0),
        status: "sent",
        sentAt: now,
        messageId: "<dev-placeholder-message-id@ethereal.invalid>",
      },
      {
        campaignId: campaignTwo.id,
        senderId: senderA.id,
        toEmail: "recipient5@example.com",
        scheduledAt: scheduledAtFor(campaignTwo, 1),
        status: "failed",
        attempts: 1,
        error: "dev seed placeholder failure",
      },
      {
        campaignId: campaignTwo.id,
        senderId: senderA.id,
        toEmail: "recipient6@example.com",
        scheduledAt: scheduledAtFor(campaignTwo, 2),
        status: "scheduled",
      },
      // campaignThree (sender B) and campaignFour (sender C, user 2):
      // one row each, enough to prove sender/user isolation.
      {
        campaignId: campaignThree.id,
        senderId: senderB.id,
        toEmail: "recipient7@example.com",
        scheduledAt: scheduledAtFor(campaignThree, 0),
        status: "scheduled",
      },
      {
        campaignId: campaignFour.id,
        senderId: senderC.id,
        toEmail: "recipient8@example.com",
        scheduledAt: scheduledAtFor(campaignFour, 0),
        status: "scheduled",
      },
    ],
  });

  console.log("Seed complete:");
  console.log(`  users: 2, senders: 3, campaigns: 4, emails: 8`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
