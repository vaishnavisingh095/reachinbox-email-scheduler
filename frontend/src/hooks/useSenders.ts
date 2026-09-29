import { useApiResource } from "./useApiResource";
import type { Sender } from "@/types/api";

export function useSenders() {
  const { data, loading, error, refetch } = useApiResource<{ senders: Sender[] }>("/senders", []);
  return { senders: data?.senders ?? [], loading, error, refetch };
}
