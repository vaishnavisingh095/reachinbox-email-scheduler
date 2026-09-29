import { useApiResource } from "./useApiResource";
import type { SlackStatus } from "@/types/api";

export function useSlackStatus() {
  const { data, loading, error, refetch } = useApiResource<SlackStatus>("/auth/slack/status", []);
  return { status: data, loading, error, refetch };
}
