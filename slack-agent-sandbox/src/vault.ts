import { createPromiseCache } from "./cache.js";
import { createJsonClient, HttpError } from "./http.js";
import type { SessionApi } from "./run.js";

export interface VaultOptions {
  /** Infisical's base URL, e.g. https://app.infisical.com. */
  domain: string;
  /**
   * The machine identity Atlas uses only for this, so its sessions are all Atlas's.
   * It must be an Agent Vault member, not an admin: Infisical lets an admin mint over any bundle,
   * while a member can mint only over the bundles granted to it.
   */
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
}

/** What GET /sessions/:id reports; the smoke test checks it after a run. */
export interface SessionStatus {
  id: string;
  /** active, revoked or expired. */
  status: string;
  revokedAt: string | null;
  expiresAt: string | null;
  accessBundles: { name: string }[];
}

/** Re-login this long before the access token expires, so a request never carries a stale one. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * Agent Vault sessions through Infisical's API (backend: ee/routes/v1/agent-vault-routers/
 * agent-vault-session-router.ts). The identity logs in with Universal Auth; its access token is
 * cached until shortly before it expires. Session tokens come back once, from create, and are
 * returned to the caller without being logged; errors carry only the status and response body.
 * Infisical allows one bundle per session today, and answers 400 for one the identity isn't granted.
 */
export function createVault({
  domain,
  clientId,
  clientSecret,
  fetch: doFetch = fetch,
  timeoutMs = 30_000,
}: VaultOptions) {
  const http = createJsonClient({ baseUrl: domain, timeoutMs, name: "Infisical", fetch: doFetch });
  const request = (method: string, path: string, body?: unknown, auth?: string) =>
    http<unknown>(method, path, { body, headers: auth ? { authorization: `Bearer ${auth}` } : undefined });

  // A single entry: the identity's access token.
  const accessToken = createPromiseCache<void, string>(async () => {
    const { accessToken, expiresIn } = (await request("POST", "/api/v1/auth/universal-auth/login", {
      clientId,
      clientSecret,
    })) as { accessToken: string; expiresIn: number };
    return { value: accessToken, ttlMs: expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS };
  });

  /** An authenticated request; on a 401 (token revoked early) logs in again once and retries. */
  async function authed(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = accessToken.get();
    try {
      return await request(method, path, body, await token);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 401)) throw err;
      accessToken.invalidate(undefined, token);
      return request(method, path, body, await accessToken.get());
    }
  }

  const sessions: SessionApi = {
    async create({ accessBundles, ttl }) {
      const { session } = (await authed("POST", "/api/v1/agent-vault/sessions", { accessBundles, ttl })) as {
        session: { id: string; token: string };
      };
      return { id: session.id, token: session.token };
    },
    async revoke(sessionId) {
      // Idempotent on Infisical's side: revoking twice returns 200.
      await authed("POST", `/api/v1/agent-vault/sessions/${encodeURIComponent(sessionId)}/revoke`);
    },
  };

  async function getSession(sessionId: string): Promise<SessionStatus> {
    const { session } = (await authed("GET", `/api/v1/agent-vault/sessions/${encodeURIComponent(sessionId)}`)) as {
      session: SessionStatus;
    };
    return session;
  }

  return { sessions, getSession };
}
