// Only people on AGENT_ALLOWLIST (comma- or space-separated emails) can use the agent.

export const NOT_ALLOWED_MESSAGE = "Sorry, I can only help people on my allowlist.";

const ALLOWED = new Set(
  (process.env.AGENT_ALLOWLIST ?? "")
    .split(/[\s,]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

export function allowlistConfigured(): boolean {
  return ALLOWED.size > 0;
}

/** Fails closed: a missing email or an empty allowlist returns false. */
export function isAllowedEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  return ALLOWED.has(email.trim().toLowerCase());
}
