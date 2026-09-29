import { useApiResource } from "./useApiResource";
import type { EmailListItem, Pagination } from "@/types/api";

export function useEmails(status: "scheduled" | "sent", page: number, limit = 20) {
  const offset = page * limit;
  const path = `/emails?status=${status}&limit=${limit}&offset=${offset}`;
  const { data, loading, error, refetch } = useApiResource<{ emails: EmailListItem[]; pagination: Pagination }>(path, [
    status,
    page,
    limit,
  ]);
  return { emails: data?.emails ?? [], pagination: data?.pagination ?? null, loading, error, refetch };
}
