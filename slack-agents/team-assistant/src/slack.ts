import { App } from "@slack/bolt";
import { chunkText } from "./chunk-text.ts";
import { requireEnv, type Config } from "./config.ts";
import { isMeantForAgent } from "./filter.ts";
import type { Runner } from "./run.ts";
import { NotCoveredError } from "./vault.ts";

type SlackClient = InstanceType<typeof App>["client"];

interface SlackUser {
  name?: string;
  email?: string;
}

/** How a run was started, which decides what it posts. */
type Trigger =
  /** A mention or a DM: shows progress, and replies even to say it can't help. */
  | "direct"
  /** A thread reply that didn't mention the bot: posts only an answer, and only if there is one. */
  | "background";

const NO_REPLY = "[no_reply]";
const STOP_FOLLOWING = "[stop_following]";

const notCoveredMessage = (name: string) =>
  `Sorry, I can't act for you yet. Ask an Agent Vault admin to add you to ${name}'s delegation, and to grant you its access bundle.`;

/**
 * The Slack side of the assistant. It answers DMs and mentions in any channel, and replies in a
 * thread it's already in when a small model thinks the reply is meant for it. Every run acts as the
 * person who asked, through an Agent Vault session on their behalf.
 */
export async function startSlackBot(config: Config, runner: Runner): Promise<App> {
  const app = new App({
    token: requireEnv("SLACK_BOT_TOKEN"),
    appToken: requireEnv("SLACK_APP_TOKEN"),
    socketMode: true,
  });
  const { user_id: botUserId } = await app.client.auth.test();
  if (!botUserId) throw new Error("auth.test returned no bot user ID");
  const botMention = `<@${botUserId}>`;

  /** Threads the agent was asked to stay out of. Kept in memory, so a restart forgets them. */
  const muted = new Set<string>();
  const threadKey = (channel: string, threadTs: string) => `${channel}:${threadTs}`;

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
      console.error(`users.info failed for ${userId}:`, (err as { data?: { error?: string } }).data?.error ?? err);
      return {};
    }
  }

  async function threadMessages(client: SlackClient, channel: string, threadTs: string) {
    try {
      const { messages } = await client.conversations.replies({ channel, ts: threadTs, limit: 200 });
      return messages ?? [];
    } catch (err) {
      // missing_scope means the app needs channels:history, groups:history or im:history.
      console.error("Failed to read the thread:", (err as { data?: { error?: string } }).data?.error ?? err);
      return [];
    }
  }

  /**
   * The thread so far, as the agent reads it. Only the requester's messages are requests. Everyone
   * else's are marked as context, since the agent acts with the requester's access.
   */
  async function transcript(client: SlackClient, channel: string, threadTs: string, requesterId: string) {
    const lines: string[] = [];
    for (const m of await threadMessages(client, channel, threadTs)) {
      if (!m.text) continue;
      const text = m.text.replaceAll(botMention, "").trim();
      if (m.user === botUserId) lines.push(`${config.name} (you): ${text}`);
      else if (m.bot_id) lines.push(`[Another bot, context only] ${m.bot_profile?.name ?? "bot"}: ${text}`);
      else {
        const name = m.user ? ((await lookUpUser(client, m.user)).name ?? `<@${m.user}>`) : "Someone";
        lines.push(m.user === requesterId ? `${name}: ${text}` : `[Someone else, context only] ${name}: ${text}`);
      }
    }
    return lines;
  }

  async function handle(
    client: SlackClient,
    { channel, channelType, ts, threadTs, user, text, trigger }: {
      channel: string;
      channelType: string;
      ts: string;
      threadTs: string;
      user: string;
      text: string;
      trigger: Trigger;
    },
  ) {
    const key = threadKey(channel, threadTs);
    if (trigger === "direct") muted.delete(key);
    const reply = (message: string) => client.chat.postMessage({ channel, thread_ts: threadTs, text: message });

    const requester = await lookUpUser(client, user);
    if (!requester.email) {
      if (trigger === "direct") await reply("Sorry, I couldn't read the email on your Slack profile, so I can't act for you.");
      return;
    }

    const isDm = channelType === "im";
    const lines = threadTs !== ts ? await transcript(client, channel, threadTs, user) : [];
    const message = text.replaceAll(botMention, "").trim();
    if (trigger === "background" && !(await isMeantForAgent(config.anthropicApiKey, lines.join("\n")))) return;

    const name = requester.name ?? `<@${user}>`;
    const prompt = [
      isDm
        ? `This is a direct message from ${name}. Only they will see your reply.`
        : `${name} is asking in a Slack channel. Everyone in the channel will see your reply.`,
      trigger === "background" ? "Their latest message doesn't mention you. Answer only if it's meant for you." : "",
      lines.length ? `The thread so far:\n\n${lines.join("\n")}` : "",
      `${name}'s latest message: ${message || "(no text)"}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    // A direct run shows a placeholder it edits with progress, then replaces with the answer.
    const placeholder = trigger === "direct" ? (await reply("Thinking…")).ts : undefined;
    let progress = Promise.resolve();
    let finished = false;
    const show = (status: string) => {
      if (!placeholder || finished) return;
      progress = progress
        .then(() => client.chat.update({ channel, ts: placeholder, text: status }))
        .then(() => {}, () => {});
    };

    let answer: string;
    try {
      answer = await runner.run({
        email: requester.email,
        label: message.split("\n")[0] || "Slack request",
        prompt,
        onQueued: () => show("I'm working on other requests. I'll start on yours as soon as one finishes…"),
        onProgress: show,
      });
    } catch (err) {
      finished = true;
      await progress;
      const notCovered = err instanceof NotCoveredError;
      console.error(notCovered ? `Not covered: ${requester.email}: ${(err as Error).message}` : "Run failed:", notCovered ? "" : err);
      if (placeholder) {
        const text = notCovered ? notCoveredMessage(config.name) : ":warning: Sorry, I ran into an error. Please try again.";
        await client.chat.update({ channel, ts: placeholder, text }).catch(() => {});
      }
      return;
    }
    finished = true;
    await progress;

    let output = answer.trim();
    const stop = output.endsWith(STOP_FOLLOWING);
    if (stop) {
      output = output.slice(0, -STOP_FOLLOWING.length).trim();
      if (!isDm) muted.add(key);
    }
    const silent = output.endsWith(NO_REPLY);
    if (silent) output = output.slice(0, -NO_REPLY.length).trim();
    if (stop && !isDm) output = [output, "OK, I'll stay out of this thread until someone tags me."].filter(Boolean).join("\n\n");

    if (!output || (silent && !stop)) {
      if (placeholder) await client.chat.delete({ channel, ts: placeholder }).catch(() => {});
      return;
    }
    const [first, ...rest] = chunkText(output);
    if (placeholder) await client.chat.update({ channel, ts: placeholder, text: first });
    else await reply(first);
    for (const chunk of rest) await reply(chunk);
  }

  // A mention anywhere the bot has been invited.
  app.event("app_mention", async ({ event, client }) => {
    if (!event.user) return;
    void handle(client, {
      channel: event.channel,
      channelType: "channel",
      ts: event.ts,
      threadTs: event.thread_ts ?? event.ts,
      user: event.user,
      text: event.text,
      trigger: "direct",
    }).catch((err) => console.error("Failed to handle a mention:", err));
  });

  // DMs, and thread replies in channels that don't mention the bot.
  app.message(async ({ message, client }) => {
    // Edits, joins and other subtypes aren't new messages from a person.
    if (message.subtype !== undefined || !("user" in message) || !message.user || message.user === botUserId) return;
    const text = message.text ?? "";
    const base = { channel: message.channel, ts: message.ts, user: message.user, text };

    if (message.channel_type === "im") {
      void handle(client, { ...base, channelType: "im", threadTs: message.thread_ts ?? message.ts, trigger: "direct" }).catch(
        (err) => console.error("Failed to handle a DM:", err),
      );
      return;
    }

    // A mention arrives as app_mention too. A reply that names someone else, @here or @channel is for them.
    // Without a key for the check, every reply in the bot's threads would start a run, so none do.
    const threadTs = message.thread_ts;
    if (!config.anthropicApiKey || !threadTs || text.includes(botMention) || /<@|<!(here|channel|everyone|subteam)/.test(text)) return;
    if (muted.has(threadKey(message.channel, threadTs))) return;
    // Only threads the bot has already posted in.
    const thread = await threadMessages(client, message.channel, threadTs);
    if (!thread.some((m) => m.user === botUserId)) return;
    void handle(client, { ...base, channelType: message.channel_type, threadTs, trigger: "background" }).catch((err) =>
      console.error("Failed to handle a thread reply:", err),
    );
  });

  await app.start();
  console.log(`${config.name} is running in Socket Mode`);
  return app;
}
