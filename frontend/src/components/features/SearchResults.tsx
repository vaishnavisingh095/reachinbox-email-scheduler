import { Search } from "lucide-react";
import { useEmailSearch } from "@/hooks/useEmailSearch";
import { StatusBadge } from "@/components/ui/Badge";
import { LoadingState, ErrorState, EmptyState } from "@/components/ui/States";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function SearchResults({ query }: { query: string }) {
  const { hits, loading, error } = useEmailSearch(query);

  if (loading) return <LoadingState label="Searching…" />;
  if (error) return <ErrorState message={error} />;
  if (hits.length === 0) {
    return (
      <EmptyState
        icon={<Search className="h-8 w-8" />}
        title="No results"
        description={`Nothing matched "${query}".`}
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-xs font-medium uppercase tracking-wide text-gray-500">
            <th className="px-4 py-3">Recipient</th>
            <th className="px-4 py-3">Subject</th>
            <th className="px-4 py-3">Sender</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Date</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {hits.map((hit) => (
            <tr key={hit.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 text-gray-900">{hit.toEmail}</td>
              <td className="max-w-[220px] truncate px-4 py-3 text-gray-600">{hit.subject}</td>
              <td className="px-4 py-3 text-gray-500">{hit.sender}</td>
              <td className="px-4 py-3">
                <StatusBadge status={hit.status} />
              </td>
              <td className="px-4 py-3 text-gray-500">{formatDate(hit.sentAt ?? hit.scheduledAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
