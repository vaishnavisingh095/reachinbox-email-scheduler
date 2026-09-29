"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Plus, Calendar, Send } from "lucide-react";
import { useEmails } from "@/hooks/useEmails";
import { EmailTable } from "@/components/features/EmailTable";
import { ComposeModal } from "@/components/features/ComposeModal";
import { Button } from "@/components/ui/Button";
import { Pagination } from "@/components/ui/Pagination";
import { LoadingState, ErrorState, EmptyState } from "@/components/ui/States";

function DashboardContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tab = searchParams.get("tab") === "sent" ? "sent" : "scheduled";
  const [page, setPage] = useState(0);
  const [composeOpen, setComposeOpen] = useState(false);

  const { emails, pagination, loading, error, refetch } = useEmails(tab, page);

  function switchTab(next: "scheduled" | "sent") {
    setPage(0);
    router.push(next === "sent" ? "/dashboard?tab=sent" : "/dashboard");
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">{tab === "sent" ? "Sent" : "Scheduled"} emails</h1>
          <p className="text-sm text-gray-500">
            {tab === "sent" ? "Delivered and failed sends across your campaigns." : "Emails queued and waiting to send."}
          </p>
        </div>
        <Button onClick={() => setComposeOpen(true)}>
          <Plus className="h-4 w-4" />
          New campaign
        </Button>
      </div>

      <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-1 w-fit">
        <button
          onClick={() => switchTab("scheduled")}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            tab === "scheduled" ? "bg-indigo-600 text-white" : "text-gray-600 hover:bg-gray-50"
          }`}
        >
          <Calendar className="h-3.5 w-3.5" />
          Scheduled
        </button>
        <button
          onClick={() => switchTab("sent")}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            tab === "sent" ? "bg-indigo-600 text-white" : "text-gray-600 hover:bg-gray-50"
          }`}
        >
          <Send className="h-3.5 w-3.5" />
          Sent
        </button>
      </div>

      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : emails.length === 0 ? (
        <EmptyState
          icon={tab === "sent" ? <Send className="h-8 w-8" /> : <Calendar className="h-8 w-8" />}
          title={tab === "sent" ? "No sent emails yet" : "No scheduled emails"}
          description={
            tab === "sent"
              ? "Once a campaign starts sending, delivered emails will show up here."
              : "Schedule a campaign and its emails will appear here."
          }
          action={
            <Button size="sm" onClick={() => setComposeOpen(true)}>
              <Plus className="h-4 w-4" />
              New campaign
            </Button>
          }
        />
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white">
          <EmailTable emails={emails} variant={tab} />
          {pagination && <Pagination pagination={pagination} page={page} onPageChange={setPage} />}
        </div>
      )}

      <ComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        onScheduled={() => {
          if (tab !== "scheduled") switchTab("scheduled");
          else refetch();
        }}
      />
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <DashboardContent />
    </Suspense>
  );
}
