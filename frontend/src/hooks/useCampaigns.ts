import { useApiResource } from "./useApiResource";
import type { Campaign, Pagination } from "@/types/api";

export function useCampaigns(page: number, limit = 20) {
  const offset = page * limit;
  const path = `/campaigns?limit=${limit}&offset=${offset}`;
  const { data, loading, error, refetch } = useApiResource<{ campaigns: Campaign[]; pagination: Pagination }>(path, [
    page,
    limit,
  ]);
  return { campaigns: data?.campaigns ?? [], pagination: data?.pagination ?? null, loading, error, refetch };
}
