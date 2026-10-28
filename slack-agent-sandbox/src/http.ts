/** An HTTP call that didn't return 2xx. `code` is the API's own error code, when it sent one. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface JsonClientOptions {
  /** Prefix for every path, e.g. https://app.infisical.com or http://host:8080/v1. */
  baseUrl: string;
  /** Sent with every request, e.g. an API token. Per-call headers are merged over them. */
  headers?: Record<string, string>;
  /** Per-request timeout, combined with any caller signal. */
  timeoutMs: number;
  /** Prefix for error messages, e.g. "Infisical". */
  name: string;
  /** Pulls the API's error code and message out of an error body; by default the raw body is used. */
  describeError?: (body: string) => { code?: string; detail: string } | undefined;
  fetch?: typeof fetch;
}

export interface JsonRequest {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * A minimal JSON-over-HTTP client. Errors carry only the status and the response body, never
 * request headers, so a token sent in a header can't end up in a log.
 */
export function createJsonClient({ baseUrl, headers: shared, timeoutMs, name, describeError, fetch: doFetch = fetch }: JsonClientOptions) {
  const base = baseUrl.replace(/\/+$/, "");
  return async function request<T>(method: string, path: string, { body, headers, signal }: JsonRequest = {}): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { ...shared, ...(body !== undefined && { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const described = describeError?.(text);
      const detail = described?.detail ?? text.slice(0, 500);
      throw new HttpError(`${name} ${method} ${path} failed: HTTP ${res.status} ${detail}`.trim(), res.status, described?.code);
    }
    return (await res.json()) as T;
  };
}
