"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { useSenders } from "@/hooks/useSenders";
import { useToast } from "@/components/ui/Toast";
import { api, ApiRequestError } from "@/lib/api";
import { parseRecipients, parseRecipientsFile } from "@/lib/parseRecipients";
import type { CreateCampaignInput, CreateCampaignResponse } from "@/types/api";

function toLocalDateTimeValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

export function ComposeModal({ open, onClose, onScheduled }: { open: boolean; onClose: () => void; onScheduled: () => void }) {
  const { senders, loading: sendersLoading, error: sendersError } = useSenders();
  const { show } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [senderId, setSenderId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [recipientText, setRecipientText] = useState("");
  const [startAt, setStartAt] = useState("");
  const [delaySeconds, setDelaySeconds] = useState("");
  const [hourlyLimit, setHourlyLimit] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState("");

  // Fresh state for every new compose action (modal open) — the
  // idempotency key stays stable across retries within one session
  // (Phase 7: "preserve the same idempotency key" on retry), but a new
  // open is a genuinely new user action and gets a new one.
  useEffect(() => {
    if (open) {
      // Intentional: this resets form state for each new open — the
      // functional equivalent of remounting the form (e.g. via a `key`),
      // done as an effect instead so the modal itself doesn't unmount
      // between opens.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSenderId("");
      setSubject("");
      setBody("");
      setRecipientText("");
      setStartAt(toLocalDateTimeValue(new Date()));
      setDelaySeconds("");
      setHourlyLimit("");
      setSubmitError(null);
      setIdempotencyKey(crypto.randomUUID());
    }
  }, [open]);

  // Derived at render time, not written into state via an effect: the
  // user's explicit choice (`senderId`) wins once made, otherwise the
  // first loaded sender is used as the value — but `senderId` itself
  // stays empty until the user actually picks something (or this default
  // is what gets submitted), so there's nothing to synchronize here.
  const effectiveSenderId = senderId || senders[0]?.id || "";

  const parsed = useMemo(() => parseRecipients(recipientText), [recipientText]);
  const hasBlockingRecipientIssues = parsed.invalid.length > 0 || parsed.duplicates.length > 0;

  async function handleFile(file: File) {
    const result = await parseRecipientsFile(file);
    const combined = [...result.valid, ...result.invalid, ...result.duplicates].join("\n");
    setRecipientText(combined);
  }

  const canSubmit =
    effectiveSenderId.length > 0 &&
    subject.trim().length > 0 &&
    body.trim().length > 0 &&
    parsed.valid.length > 0 &&
    !hasBlockingRecipientIssues &&
    !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);

    const payload: CreateCampaignInput = {
      senderId: effectiveSenderId,
      subject: subject.trim(),
      body,
      recipients: parsed.valid,
    };
    if (startAt) payload.startAt = new Date(startAt).toISOString();
    if (delaySeconds) payload.delayBetweenEmailsMs = Math.round(Number(delaySeconds) * 1000);
    if (hourlyLimit) payload.hourlyLimit = Number(hourlyLimit);

    try {
      const res = await api.post<CreateCampaignResponse>("/campaigns", payload, { "Idempotency-Key": idempotencyKey });
      show("success", `Campaign scheduled — ${res.emails.length} email${res.emails.length === 1 ? "" : "s"} queued.`);
      onScheduled();
      onClose();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setSubmitError(err.message);
      } else {
        setSubmitError("Something went wrong scheduling this campaign. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New campaign" maxWidthClassName="max-w-2xl">
      <div className="flex flex-col gap-4">
        {sendersError && <p className="text-sm text-red-600">Couldn&apos;t load senders: {sendersError}</p>}
        {!sendersLoading && senders.length === 0 && !sendersError && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            You don&apos;t have any senders yet. A campaign needs exactly one sender — contact an admin to have one
            provisioned before you can schedule a campaign.
          </p>
        )}

        <Select
          label="From"
          value={effectiveSenderId}
          onChange={(e) => setSenderId(e.target.value)}
          disabled={sendersLoading || senders.length === 0}
        >
          <option value="" disabled>
            {sendersLoading ? "Loading senders…" : "Select a sender"}
          </option>
          {senders.map((s) => (
            <option key={s.id} value={s.id}>
              {s.email} ({s.currentHourUsage.used}/{s.currentHourUsage.limit} sent this hour)
            </option>
          ))}
        </Select>

        <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Your subject line" />

        <Textarea
          label="Body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          placeholder="Write your email…"
        />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-gray-700">Recipients</label>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
            >
              <Upload className="h-3.5 w-3.5" />
              Upload CSV
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
                e.target.value = "";
              }}
            />
          </div>
          <Textarea
            value={recipientText}
            onChange={(e) => setRecipientText(e.target.value)}
            rows={4}
            placeholder="Paste email addresses — separated by commas or one per line"
          />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span className="font-medium text-gray-700">{parsed.valid.length} valid recipient{parsed.valid.length === 1 ? "" : "s"}</span>
            {parsed.invalid.length > 0 && (
              <span className="text-red-600">
                {parsed.invalid.length} invalid: {parsed.invalid.slice(0, 5).join(", ")}
                {parsed.invalid.length > 5 ? "…" : ""}
              </span>
            )}
            {parsed.duplicates.length > 0 && (
              <span className="text-amber-600">
                {parsed.duplicates.length} duplicate: {parsed.duplicates.slice(0, 5).join(", ")}
                {parsed.duplicates.length > 5 ? "…" : ""}
              </span>
            )}
          </div>
          {hasBlockingRecipientIssues && (
            <p className="text-xs text-gray-500">Remove invalid or duplicate addresses before scheduling.</p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input
            label="Start time"
            type="datetime-local"
            value={startAt}
            onChange={(e) => setStartAt(e.target.value)}
          />
          <Input
            label="Delay between emails"
            type="number"
            min={0}
            step="0.1"
            value={delaySeconds}
            onChange={(e) => setDelaySeconds(e.target.value)}
            placeholder="Default"
            hint="seconds"
          />
          <Input
            label="Hourly limit"
            type="number"
            min={1}
            step={1}
            value={hourlyLimit}
            onChange={(e) => setHourlyLimit(e.target.value)}
            placeholder="Default"
            hint="emails / hour"
          />
        </div>

        {submitError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{submitError}</p>}

        <div className="flex justify-end gap-2 border-t border-gray-100 pt-4">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
            Schedule campaign
          </Button>
        </div>
      </div>
    </Modal>
  );
}
