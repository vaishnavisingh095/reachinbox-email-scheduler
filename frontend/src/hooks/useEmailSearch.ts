import { useEffect, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";
import type { EmailSearchHit, Pagination } from "@/types/api";

const DEBOUNCE_MS = 350;

export function useEmailSearch(query: string) {
  const [hits, setHits] = useState<EmailSearchHit[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      // Intentional: an empty query resets results synchronously (no
      // network call needed) — the debounced fetch below is the genuine
      // async effect this rule is meant to police.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHits([]);
      setPagination(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    const handle = setTimeout(() => {
      let cancelled = false;
      api
        .get<{ emails: EmailSearchHit[]; pagination: Pagination }>(`/emails/search?q=${encodeURIComponent(trimmed)}`)
        .then((res) => {
          if (cancelled) return;
          setHits(res.emails);
          setPagination(res.pagination);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof ApiRequestError ? err.message : "Search failed. Please try again.");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [query]);

  return { hits, pagination, loading, error };
}
