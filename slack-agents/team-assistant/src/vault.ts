import { InfisicalSDK, InfisicalSDKRequestError } from "@infisical/sdk";
import type { Config } from "./config.ts";

/** Infisical refused to start a session for this person, so they can't use the assistant. */
export class NotCoveredError extends Error {}

export interface Session {
  id: string;
  token: string;
}

/** Infisical's limit on a session label. */
const LABEL_MAX_CHARS = 128;

/**
 * Agent Vault sessions for the assistant's machine identity, each on behalf of the person who asked.
 * The identity needs a delegation that covers them and a grant to the access bundle, and the session
 * reaches only what both the identity and the person can reach.
 */
export function createVault(config: Config) {
  // Logs in for each call, so a long-running orchestrator never holds an expired access token.
  async function client(): Promise<InfisicalSDK> {
    const infisical = new InfisicalSDK({ siteUrl: config.infisicalDomain });
    await infisical.auth().universalAuth.login({ clientId: config.clientId, clientSecret: config.clientSecret });
    return infisical;
  }

  return {
    /** Starts a session on the access bundle, on behalf of `email`, that lasts `ttlMinutes`. */
    async startSession({ email, ttlMinutes, label }: { email: string; ttlMinutes: number; label: string }): Promise<Session> {
      const infisical = await client();
      try {
        const session = await infisical.agentVault().sessions.create({
          projectId: config.projectId,
          accessBundle: config.accessBundle,
          onBehalfOfUserEmail: email,
          ttl: `${Math.ceil(ttlMinutes)}m`,
          label: sessionLabel(label),
        });
        return { id: session.id, token: session.token };
      } catch (err) {
        // 403 and 404 are what Infisical answers for a person the delegation doesn't cover, or who
        // isn't in the organization. It gives both the same message on purpose.
        if (err instanceof InfisicalSDKRequestError && (err.statusCode === 403 || err.statusCode === 404)) {
          throw new NotCoveredError(err.message);
        }
        throw err;
      }
    },

    async revokeSession(id: string): Promise<void> {
      await (await client()).agentVault().sessions.revoke(id);
    },
  };
}

export type Vault = ReturnType<typeof createVault>;

/** A label Infisical accepts: no control or format characters, one line, at most 128 characters. */
export function sessionLabel(text: string): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= LABEL_MAX_CHARS) return clean || "Slack request";
  // Never end on half of a surrogate pair, which Infisical refuses.
  return `${clean.slice(0, LABEL_MAX_CHARS - 1).replace(/[\uD800-\uDBFF]$/, "").trimEnd()}…`;
}
