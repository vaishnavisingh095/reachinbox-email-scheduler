"use client";

import { Suspense, useState, type ReactNode } from "react";
import { RequireAuth } from "@/components/features/RequireAuth";
import { Sidebar } from "@/components/features/Sidebar";
import { Header } from "@/components/features/Header";
import { SearchResults } from "@/components/features/SearchResults";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");

  return (
    <RequireAuth>
      <div className="flex h-screen overflow-hidden">
        <Suspense>
          <Sidebar />
        </Suspense>
        <div className="flex min-w-0 flex-1 flex-col">
          <Header onSearch={setQuery} />
          <main className="flex-1 overflow-y-auto bg-gray-50 p-6">
            {query.trim() ? <SearchResults query={query} /> : children}
          </main>
        </div>
      </div>
    </RequireAuth>
  );
}
