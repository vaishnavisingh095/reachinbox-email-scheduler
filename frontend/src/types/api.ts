// Types mirror the backend's actual response shapes exactly (see
// backend/src/routes/*.ts) — no invented fields.

export interface User {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export interface Sender {
  id: string;
  email: string;
  createdAt: string;
  currentHourUsage: { used: number; limit: number };
}

export type EmailStatus = "scheduled" | "processing" | "sent" | "failed";

export interface CampaignProgress {
  total: number;
  scheduled: number;
  processing: number;
  sent: number;
  failed: number;
}

export interface Campaign {
  id: string;
  sender: { id: string; email: string };
  subject: string;
  startAt: string;
  delayBetweenEmailsMs: number;
  hourlyLimit: number;
  createdAt: string;
  progress: CampaignProgress;
}

export interface CreateCampaignResponse {
  campaign: {
    id: string;
    senderId: string;
    subject: string;
    body: string;
    startAt: string;
    delayBetweenEmailsMs: number;
    hourlyLimit: number;
  };
  emails: { id: string; toEmail: string; scheduledAt: string }[];
}

// GET /emails?status= — `sender` is an object here.
export interface EmailListItem {
  id: string;
  toEmail: string;
  subject: string;
  sender: { id: string; email: string };
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  error: string | null;
  previewUrl: string | null;
  campaignId: string;
}

// GET /emails/search — `sender` is a plain string here (a real, minor
// inconsistency between the two endpoints on the backend, not something
// to paper over by pretending they match).
export interface EmailSearchHit {
  id: string;
  toEmail: string;
  subject: string;
  sender: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  campaignId: string;
}

export interface Pagination {
  limit: number;
  offset: number;
  total: number;
}

export interface SlackStatus {
  connected: boolean;
  teamName?: string;
}

export interface ApiError {
  error: { code: string; message: string };
}

export interface CreateCampaignInput {
  senderId: string;
  subject: string;
  body: string;
  recipients: string[];
  startAt?: string;
  delayBetweenEmailsMs?: number;
  hourlyLimit?: number;
}
