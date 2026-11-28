import { App } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { allowlistConfigured, isAllowedEmail, NOT_ALLOWED_MESSAGE } from "./access.ts";
import { chunkText } from "./chunk-text.ts";
import { requireEnv, type Agent } from "./config.ts";
import { runClaude } from "./run-claude.ts";

const AGENT_CHANNEL_ID = process.env.AGENT_CHANNEL_ID?.trim() || "";

type SlackClient = InstanceType<typeof App>["client"];

interface SlackUser {
  name?: string;
  email?: string;
}

const LATEST_MESSAGE_MARKER = "Respond to this latest message:";

const SLACK_FORMATTING = `You're answering in a Slack thread. Be concise, use no emojis, and format with Slack's syntax: *bold*, _italic_, bullets with •, and \`\`\` code blocks. Write links as <url|label>, never [label](url).`;

export async function startSlackBot(agent: Agent): Promise<void> {
  const botToken = requireEnv("SLACK_BOT_TOKEN");
  const appToken = requireEnv("SLACK_APP_TOKEN");

  // The proxy swaps the placeholder token only in headers, never in a request body. Bolt's own
  // auth.test sends the token in the body, so the bot's IDs come from a header-authenticated call
  // and Bolt's token verification stays off.
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
      // missing_scope means the app needs users:read and users:read.email.
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
      // missing_scope means the app needs groups:history or channels:history.
      const code = (err as { data?: { error?: string } }).data?.error;
      console.error(`Failed to read the thread${code ? ` (${code})` : ""}:`, err);
      return latest;
    }

    const lines: string[] = [];
    for (const m of messages ?? []) {
      if (!m.text) continue;
      const text = stripBotMention(m.text);
      if (m.user === botUserId || m.bot_id) {
        const name = m.user === botUserId ? agent.name : (m.bot_profile?.name ?? "Another bot");
        lines.push(`${name}: ${text}`);
      } else {
        // Leave out people who aren't on the allowlist, so they can't steer the agent through the thread.
        const user = m.user ? await lookUpUser(client, m.user) : {};
        if (!isAllowedEmail(user.email)) continue;
        lines.push(`${user.name ?? `<@${m.user}>`}: ${text}`);
      }
    }

    // replies returns the oldest messages first, so a long thread can be missing the latest one.
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

    // The answer waits for the last progress update, so a slow update can't overwrite it.
    let lastProgress = "";
    let progressUpdates = Promise.resolve();
    let finished = false;
    const finishProgress = () => {
      finished = true;
      return progressUpdates;
    };

    const { permalink } = await client.chat
      .getPermalink({ channel, message_ts: threadTs })
      .catch(() => ({ permalink: undefined }));
    const requesterName = requester.name ?? `<@${event.user}>`;
    const context = `${SLACK_FORMATTING}\n\nRequested by ${requesterName}${permalink ? ` in ${permalink}` : ""}.\n\n`;

    try {
      const answer = await runClaude(agent, context + prompt, (progress) => {
        if (finished || progress === lastProgress) return;
        lastProgress = progress;
        progressUpdates = progressUpdates
          .then(() => client.chat.update({ channel, ts: thinkingTs, text: progress }))
          .then(() => {}, () => {});
      });

      await finishProgress();
      const [first, ...rest] = chunkText(answer || "I couldn't find an answer. Try rephrasing your question.");
      await client.chat.update({ channel, ts: thinkingTs, text: first });
      for (const chunk of rest) await reply(chunk);
    } catch (err) {
      console.error("Agent error:", err);
      await finishProgress();
      await client.chat
        .update({ channel, ts: thinkingTs, text: ":warning: Sorry, I ran into an error. Please try again." })
        .catch((updateErr) => console.error("Failed to post the error message:", updateErr));
    }
  });

  await app.start();
  console.log(`${agent.name} is running in Socket Mode`);
}
