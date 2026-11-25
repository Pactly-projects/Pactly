/**
 * Typed fetch client for `/api/*` (proxied to the backend by
 * `vite.config.ts`, prefix stripped, so the browser never hits CORS). The
 * one place a non-2xx response is turned into a typed {@link ApiError}
 * carrying the backend's own `{code, message, details?}` envelope (AD-11)
 * -- every screen catches this shape, never a raw `Response`.
 */

export interface ApiErrorEnvelope {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(envelope: ApiErrorEnvelope, status: number) {
    super(envelope.message);
    this.name = "ApiError";
    this.code = envelope.code;
    this.status = status;
    this.details = envelope.details;
  }
}

function authHeaders(token?: string): HeadersInit | undefined {
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

/** Issue #13: the short-lived passkey assertion a money-action route
 * requires alongside the normal session token. */
function assertionHeaders(assertionToken?: string): HeadersInit | undefined {
  return assertionToken ? { "x-pactly-assertion": assertionToken } : undefined;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError({ code: "NETWORK", message: "Connection dropped. Your deposit is untouched." }, 0);
  }

  if (!response.ok) {
    const envelope = await response
      .json()
      .catch(() => ({ code: "unknown_error", message: "Connection dropped. Your deposit is untouched." }));
    throw new ApiError(envelope as ApiErrorEnvelope, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export interface ApiRequestOptions {
  /** A fresh passkey-confirmation token (`/auth/assertion/verify`) for a
   * money action build route. */
  assertionToken?: string;
}

export function apiGet<T>(path: string, token?: string): Promise<T> {
  return request<T>(path, { headers: authHeaders(token) });
}

export function apiPost<T>(path: string, body: unknown, token?: string, options: ApiRequestOptions = {}): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { ...authHeaders(token), ...assertionHeaders(options.assertionToken) },
    body: JSON.stringify(body),
  });
}

export function apiPut<T>(path: string, body: unknown, token?: string): Promise<T> {
  return request<T>(path, { method: "PUT", headers: authHeaders(token), body: JSON.stringify(body) });
}

export function apiDelete<T>(path: string, token?: string): Promise<T> {
  return request<T>(path, { method: "DELETE", headers: authHeaders(token) });
}

/** A binary export (e.g. the provider's bookings CSV). Same auth and typed
 * error envelope as the JSON helpers, but hands back the raw blob instead
 * of trying to parse it; the filename comes from the response headers when
 * the server supplies one. */
export async function apiDownload(
  path: string,
  token?: string,
): Promise<{ blob: Blob; filename?: string }> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { headers: authHeaders(token) });
  } catch {
    throw new ApiError({ code: "NETWORK", message: "Connection dropped. Your deposit is untouched." }, 0);
  }
  if (!response.ok) {
    const envelope = await response
      .json()
      .catch(() => ({ code: "unknown_error", message: "Connection dropped. Your deposit is untouched." }));
    throw new ApiError(envelope as ApiErrorEnvelope, response.status);
  }
  const filename = response.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/i)?.[1];
  return { blob: await response.blob(), filename };
}
