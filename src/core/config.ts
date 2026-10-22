/** The Claude model every agent runs on. */
export const AGENT_MODEL = process.env.AGENT_MODEL?.trim() || "claude-sonnet-5-5";

/** The one Slack channel the agent answers in. Unset means it answers nowhere. */
export const AGENT_CHANNEL_ID = process.env.AGENT_CHANNEL_ID?.trim() || "";

/** Used to build links back to the Slack thread, e.g. https://acme.slack.com. */
export const SLACK_WORKSPACE_URL = process.env.SLACK_WORKSPACE_URL?.trim().replace(/\/+$/, "") || "";

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
