import { App } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { LATEST_MESSAGE_MARKER, type Agent } from "./agent.ts";
import { allowlistConfigured, isAllowedEmail, NOT_ALLOWED_MESSAGE } from "./access.ts";
import { chunkText } from "./chunk-text.ts";
import { AGENT_CHANNEL_ID, requireEnv, SLACK_WORKSPACE_URL } from "./config.ts";
import { runAgent } from "./run-agent.ts";
import { stripToolProtocolSyntax } from "./tool-syntax-guard.ts";

type SlackClient = InstanceType<typeof App>["client"];

interface SlackUser {
  name?: string;
  email?: string;
}

/**
 * Start the agent as a Socket Mode Slack bot. It answers @mentions in AGENT_CHANNEL_ID only, from
 * people on AGENT_ALLOWLIST, and reads the whole thread as context.
 */
export async function startSlackBot(agent: Agent): Promise<void> {
  const botToken = requireEnv("SLACK_BOT_TOKEN");
  const appToken = requireEnv("SLACK_APP_TOKEN");

  // Behind Agent Vault, SLACK_BOT_TOKEN is a placeholder that the proxy swaps for the real token in
  // the Authorization header. The proxy can't rewrite a request body, so the token must never go in
  // one. @slack/web-api puts a per-call `token` argument in the form body, so every call here uses
  // the client-level token instead. For the same reason Bolt gets the bot's ids up front and token
  // verification off: otherwise it calls auth.test with the token in the body and gets invalid_auth.
  const identity = await new WebClient(botToken).auth.test();
  const botUserId = identity.user_id;
  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
    tokenVerificationEnabled: false,
    botId: identity.bot_id,
    botUserId,
  });

  if (!AGENT_CHANNEL_ID) console.warn(`AGENT_CHANNEL_ID is empty, so ${agent.name} will ignore every mention.`);
  if (!allowlistConfigured()) console.warn(`AGENT_ALLOWLIST is empty, so ${agent.name} will decline every request.`);

  const stripBotMention = (text: string) => (botUserId ? text.replaceAll(`<@${botUserId}>`, "") : text).trim();

  // One users.info call per person per process gives both the email (for the allowlist) and the
  // display name (so the transcript reads "Alex: ..." instead of "<@U123>: ...").
  const users = new Map<string, SlackUser>();
  async function lookUpUser(client: SlackClient, userId: string): Promise<SlackUser> {
    const cached = users.get(userId);
    if (cached) return cached;
    try {
      const { user } = await client.users.info({ user: userId });
      const found = {
        name: user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name,
        email: user?.profile?.email,
      };
      users.set(userId, found);
      return found;
    } catch (err) {
      // missing_scope means the app needs users:read and users:read.email. The allowlist then fails closed.
      const code = (err as { data?: { error?: string } }).data?.error;
      console.error(`users.info failed${code ? ` (${code})` : ""}:`, err);
      return {};
    }
  }

  async function buildPrompt(client: SlackClient, channel: string, threadTs: string, latest: string) {
    let messages;
    try {
      ({ messages } = await client.conversations.replies({ channel, ts: threadTs, limit: 200 }));
    } catch (err) {
      // missing_scope means the app needs groups:history (private channel) or channels:history (public).
      const code = (err as { data?: { error?: string } }).data?.error;
      console.error(`Failed to read the thread${code ? ` (${code})` : ""}:`, err);
      return latest;
    }

    const lines: string[] = [];
    for (const m of messages ?? []) {
      if (!m.text) continue;
      const text = stripBotMention(m.text);
      if (m.user === botUserId || m.bot_id) {
        // Strip fake tool transcripts from past answers so the model doesn't learn to copy them.
        lines.push(`${agent.name}: ${stripToolProtocolSyntax(text)}`);
      } else {
        const name = m.user ? (await lookUpUser(client, m.user)).name : undefined;
        lines.push(`${name ?? `<@${m.user}>`}: ${text}`);
      }
    }

    // replies returns the oldest messages first, so on a long thread the latest one can be cut off.
    // Always append it.
    return `Conversation in this Slack thread so far:\n\n${lines.join("\n")}\n\n${LATEST_MESSAGE_MARKER} ${latest}`;
  }

  app.event("app_mention", async ({ event, client }) => {
    if (event.channel !== AGENT_CHANNEL_ID) {
      console.log(`Ignoring a mention in ${event.channel}. Only ${AGENT_CHANNEL_ID || "no channel"} is allowed.`);
      return;
    }
    const { channel } = event;
    const threadTs = event.thread_ts ?? event.ts;
    const reply = (text: string) => client.chat.postMessage({ channel, thread_ts: threadTs, text });

    const requester = event.user ? await lookUpUser(client, event.user) : {};
    if (!isAllowedEmail(requester.email)) {
      await reply(NOT_ALLOWED_MESSAGE);
      return;
    }

    const message = stripBotMention(event.text);
    if (!message) {
      await reply(`Hey, it's ${agent.name}. What do you need?`);
      return;
    }

    const [prompt, thinking] = await Promise.all([
      event.thread_ts ? buildPrompt(client, channel, threadTs, message) : Promise.resolve(message),
      reply("Thinking..."),
    ]);
    const thinkingTs = thinking.ts;
    if (!thinkingTs) return;

    try {
      let lastProgress = "";
      const answer = await runAgent(agent, prompt, {
        context: {
          requesterName: requester.name ?? `<@${event.user}>`,
          threadUrl: SLACK_WORKSPACE_URL
            ? `${SLACK_WORKSPACE_URL}/archives/${channel}/p${threadTs.replace(".", "")}`
            : undefined,
        },
        onProgress: (progress) => {
          if (progress === lastProgress) return;
          lastProgress = progress;
          client.chat.update({ channel, ts: thinkingTs, text: progress }).catch(() => {});
        },
      });

      const [first, ...rest] = chunkText(answer || "I couldn't find an answer. Try rephrasing your question.");
      await client.chat.update({ channel, ts: thinkingTs, text: first });
      for (const chunk of rest) await reply(chunk);
    } catch (err) {
      console.error("Agent error:", err);
      await client.chat
        .update({ channel, ts: thinkingTs, text: ":warning: Sorry, I ran into an error. Please try again." })
        .catch((updateErr) => console.error("Failed to post the error message:", updateErr));
    }
  });

  await app.start();
  console.log(`${agent.name} is running in Socket Mode`);
}
