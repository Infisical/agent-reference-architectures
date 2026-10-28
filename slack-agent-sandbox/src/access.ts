/**
 * Who may run the agent. The agent has a shell in its container, so this gates every message.
 *
 * SLACK_ALLOWLIST holds Slack user IDs (U0123ABCD) and/or emails, comma- or whitespace-separated:
 *   SLACK_ALLOWLIST="U0123ABCD, alex@example.com"
 * IDs are matched directly. Emails need a users.info lookup (scopes users:read and
 * users:read.email), done only when the list has emails and the ID didn't match. An email only
 * counts for a live human in the bot's own workspace or org (see memberEmail): through Slack
 * Connect, another org's admin sets their users' emails and could claim a listed one.
 *
 * Fails closed: an empty allowlist, a missing user, or a failed lookup denies.
 */

import { createPromiseCache } from "./cache.js";

/** The bot's own workspace and org, from auth.test. */
export interface HomeTeam {
  teamId?: string;
  enterpriseId?: string;
}

/** The users.info fields memberEmail reads. */
export interface SlackUser {
  team_id?: string;
  enterprise_user?: { enterprise_id?: string };
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { email?: string };
}

/** The user's email if it can grant access: not deleted, not a bot, and from the home team. */
export function memberEmail(user: SlackUser | undefined, home: HomeTeam): string | undefined {
  if (!user || user.deleted || user.is_bot) return undefined;
  const sameOrg = !!home.enterpriseId && user.enterprise_user?.enterprise_id === home.enterpriseId;
  const sameTeam = !!home.teamId && user.team_id === home.teamId;
  return sameOrg || sameTeam ? user.profile?.email : undefined;
}

/** How long a looked-up email is trusted, so an email change or deactivation takes effect. */
export const EMAIL_CACHE_MS = 5 * 60 * 1000;

export interface Allowlist {
  userIds: Set<string>;
  emails: Set<string>;
}

export function parseAllowlist(raw: string | undefined): Allowlist {
  const userIds = new Set<string>();
  const emails = new Set<string>();
  for (const entry of (raw ?? "").split(/[\s,]+/)) {
    if (!entry) continue;
    if (entry.includes("@")) emails.add(entry.toLowerCase());
    else userIds.add(entry.toUpperCase());
  }
  return { userIds, emails };
}

export interface AccessOptions {
  allowlist: Allowlist;
  /** Resolves a Slack user ID to their email, or undefined if it has none. */
  lookupEmail: (userId: string) => Promise<string | undefined>;
  log?: (message: string) => void;
  now?: () => number;
}

export function createAccessCheck({ allowlist, lookupEmail, log = console.log, now = Date.now }: AccessOptions) {
  if (allowlist.userIds.size + allowlist.emails.size === 0) {
    log("SLACK_ALLOWLIST is empty: every message will be refused");
  }

  // Concurrent messages from one user share a users.info call. "" means the user has no email.
  // Failures aren't cached, so a transient Slack error doesn't lock someone out until expiry.
  const emails = createPromiseCache(
    async (userId: string) => ({ value: (await lookupEmail(userId))?.toLowerCase() ?? "", ttlMs: EMAIL_CACHE_MS }),
    now,
  );

  return async function isAllowed(userId: string | undefined): Promise<boolean> {
    if (!userId) return false;
    if (allowlist.userIds.has(userId)) return true;
    if (allowlist.emails.size === 0) return false;

    try {
      return allowlist.emails.has(await emails.get(userId));
    } catch (err) {
      log(`Failed to look up email for ${userId}: ${err}`);
      return false;
    }
  };
}
