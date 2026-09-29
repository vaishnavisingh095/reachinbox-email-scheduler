import { useCallback, useEffect, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";

interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Shared GET-and-track-state hook every list/detail hook below is built
 * on, so loading/error/refetch behave identically everywhere instead of
 * being reimplemented per screen.
 */
export function useApiResource<T>(path: string | null, deps: unknown[]): ResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!path) {
      // Intentional: no path means "nothing to fetch," so loading resolves
      // immediately — not a derived-state smell, just the no-op branch of
      // an otherwise-genuine fetch-on-mount/dep-change effect below.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<T>(path)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiRequestError ? err.message : "Something went wrong. Please try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);

  return { data, loading, error, refetch };
}
