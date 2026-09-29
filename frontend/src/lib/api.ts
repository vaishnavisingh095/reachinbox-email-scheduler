import type { ApiError } from "@/types/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL;

if (!API_URL && typeof window !== "undefined") {
  // Fail loudly in the browser console rather than silently hitting a
  // relative/undefined URL — NEXT_PUBLIC_API_URL must be set.
  console.error("NEXT_PUBLIC_API_URL is not set — API calls will fail.");
}

export class ApiRequestError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE" | "PATCH";
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * The one fetch helper every API call goes through: always sends the
 * session cookie (`credentials: "include"`), always parses the backend's
 * `{error:{code,message}}` shape on failure, never leaves a caller to
 * repeat that boilerplate.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    credentials: "include",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok) {
    const errBody = json as Partial<ApiError> | null;
    throw new ApiRequestError(
      res.status,
      errBody?.error?.code ?? "UNKNOWN_ERROR",
      errBody?.error?.message ?? `Request failed with status ${res.status}`
    );
  }

  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, { method: "POST", body, headers }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}
