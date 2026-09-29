"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiRequestError } from "./api";
import type { User } from "@/types/api";

interface AuthState {
  user: User | null;
  loading: boolean;
  refetch: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const me = await api.get<User>("/auth/me");
      setUser(me);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        setUser(null);
      } else {
        // A non-auth failure (network, 500) shouldn't be silently treated
        // as "logged out" — but there's nothing more specific to show here
        // than "not currently known to be logged in"; pages needing data
        // will surface their own error state from their own fetches.
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Intentional: fetch the current session once on mount. `refetch` is
    // genuinely async (a real network call to /auth/me) — this is the
    // standard fetch-on-mount pattern, not a synchronous state derivation
    // this rule is meant to catch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refetch();
  }, [refetch]);

  const logout = useCallback(async () => {
    await api.post("/auth/logout");
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, loading, refetch, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
