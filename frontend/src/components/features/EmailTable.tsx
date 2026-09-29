import { ExternalLink } from "lucide-react";
import { StatusBadge } from "@/components/ui/Badge";
import type { EmailListItem } from "@/types/api";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function EmailTable({ emails, variant }: { emails: EmailListItem[]; variant: "scheduled" | "sent" }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-xs font-medium uppercase tracking-wide text-gray-500">
            <th className="px-4 py-3">Recipient</th>
            <th className="px-4 py-3">Subject</th>
            <th className="px-4 py-3">Sender</th>
            <th className="px-4 py-3">{variant === "scheduled" ? "Scheduled for" : "Sent at"}</th>
            <th className="px-4 py-3">Status</th>
            {variant === "sent" && <th className="px-4 py-3">Preview</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {emails.map((email) => (
            <tr key={email.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 text-gray-900">{email.toEmail}</td>
              <td className="max-w-[220px] truncate px-4 py-3 text-gray-600">{email.subject}</td>
              <td className="px-4 py-3 text-gray-500">{email.sender.email}</td>
              <td className="px-4 py-3 text-gray-500">
                {variant === "scheduled" ? formatDate(email.scheduledAt) : formatDate(email.sentAt)}
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={email.status} />
                {email.status === "failed" && email.error && (
                  <span className="ml-2 hidden text-xs text-red-500 sm:inline" title={email.error}>
                    {email.error.length > 30 ? email.error.slice(0, 30) + "…" : email.error}
                  </span>
                )}
              </td>
              {variant === "sent" && (
                <td className="px-4 py-3">
                  {email.previewUrl ? (
                    <a
                      href={email.previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-700"
                    >
                      View <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
