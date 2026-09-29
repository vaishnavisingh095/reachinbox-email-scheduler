"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Calendar, Send, Mail, MessageSquare } from "lucide-react";
import { useSlackStatus } from "@/hooks/useSlackStatus";
import { apiUrl, api, ApiRequestError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";

const navItems = [
  { key: "scheduled", label: "Scheduled", href: "/dashboard", icon: Calendar },
  { key: "sent", label: "Sent", href: "/dashboard?tab=sent", icon: Send },
];

export function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeTab = searchParams.get("tab") === "sent" ? "sent" : "scheduled";
  const { status, loading, refetch } = useSlackStatus();
  const { show } = useToast();
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await api.del("/auth/slack");
      show("success", "Slack disconnected.");
      refetch();
    } catch (err) {
      show("error", err instanceof ApiRequestError ? err.message : "Couldn't disconnect Slack.");
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-gray-200 bg-white">
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
          <Mail className="h-4 w-4 text-white" />
        </div>
        <span className="text-sm font-semibold text-gray-900">ReachInbox</span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3">
        {navItems.map((item) => {
          const isActive = pathname === "/dashboard" && activeTab === item.key;
          const Icon = item.icon;
          return (
            <Link
              key={item.key}
              href={item.href}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive ? "bg-indigo-50 text-indigo-700" : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
              }`}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-gray-200 p-3">
        <div className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2.5">
          <MessageSquare className="h-4 w-4 shrink-0 text-gray-500" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-gray-700">Slack</p>
            <p className="truncate text-xs text-gray-400">
              {loading ? "…" : status?.connected ? status.teamName ?? "Connected" : "Not connected"}
            </p>
          </div>
          {!loading && !status?.connected && (
            <Button
              size="sm"
              variant="secondary"
              className="px-2! py-1! text-xs"
              onClick={() => {
                window.location.href = apiUrl("/auth/slack/install");
              }}
            >
              Connect
            </Button>
          )}
          {!loading && status?.connected && (
            <Button size="sm" variant="ghost" className="px-2! py-1! text-xs" loading={disconnecting} onClick={handleDisconnect}>
              Disconnect
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}
