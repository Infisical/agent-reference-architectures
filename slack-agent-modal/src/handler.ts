import type { RunOptions } from "./run.js";

export const THINKING_TEXT = "Thinking...";
export const QUEUED_TEXT = ":hourglass_flowing_sand: Waiting for a free sandbox...";
export const NOT_ALLOWED_REPLY = "Sorry, you don't have access to this agent.";
export const EMPTY_MESSAGE_REPLY = "Hey! How can I help?";
export const NO_ANSWER_REPLY = "I couldn't find an answer. Try rephrasing your question.";
export const ERROR_REPLY = ":warning: Sorry, I ran into an error. Please try again.";

/** How many recent message IDs to remember for dropping duplicate deliveries. */
const SEEN_MAX = 1000;

export interface SlackMessage {
  user?: string;
  bot_id?: string;
  text?: string;
}

/** The slice of Slack's Web API the handler needs; main.ts adapts Bolt's client to it. */
export interface SlackApi {
  postMessage(args: { channel: string; thread_ts: string; text: string }): Promise<{ ts?: string }>;
  update(args: { channel: string; ts: string; text: string }): Promise<unknown>;
  replies(args: { channel: string; ts: string }): Promise<{ messages?: SlackMessage[] }>;
}

/** A message from a person; gateway.ts drops bots' messages, including the agent's own. */
export interface IncomingMessage {
  /** The sender's Slack user ID; checked against the allowlist. */
  user?: string;
  text: string;
  channel: string;
  /** The message's own ts. Slack can deliver a message twice; the second is dropped. */
  ts?: string;
  threadTs: string;
  isThreadReply: boolean;
  /** A direct message: always answered, no mention needed. */
  isDm?: boolean;
}

/** Runs one prompt in a sandbox and resolves with the agent's answer (run.ts). */
export interface PromptRunner {
  run(prompt: string, options: RunOptions): Promise<string>;
}

export interface HandlerOptions {
  slack: SlackApi;
  runner: PromptRunner;
  /**
   * Access bundles every run's session carries. v1 is one configured default; choosing them per
   * Slack user belongs here, where the sender is known, rather than anywhere the agent can reach.
   */
  accessBundles: string[];
  /** Whether the sender may run the agent (see access.ts). */
  isAllowed: (userId: string | undefined) => Promise<boolean>;
  botUserId?: string;
  log?: (message: string) => void;
  /** Minimum time between progress edits; chat.update allows about one call a second. */
  progressIntervalMs?: number;
}

const DETAIL_MAX = 100;
const NARRATION_MAX = 200;
/** Characters per reply message. Slack rejects text over 40,000 and advises staying under 4,000. */
const MESSAGE_MAX = 4000;

/** Escapes Slack's control characters, so agent text can't post a mention like <!channel>. */
const escapeSlack = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** One line, at most `max` characters, safe to put in a Slack message. */
const brief = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return escapeSlack(line.length > max ? `${line.slice(0, max - 1)}…` : line);
};

/** The placeholder's text while the agent works: the narration before its current tool, then the tool. */
export function progressText(tool: { name?: string; detail?: string }, narration?: string): string {
  const name = brief(tool.name ?? "a tool", DETAIL_MAX);
  const toolLine = tool.detail
    ? `:hammer_and_wrench: ${name}: ${brief(tool.detail, DETAIL_MAX)}`
    : `:hammer_and_wrench: Running ${name}…`;
  return narration ? `:speech_balloon: ${brief(narration, NARRATION_MAX)}\n${toolLine}` : toolLine;
}

/**
 * Sends progress edits one at a time, at most one per `intervalMs`. Text set while an edit is in
 * flight or too soon after one waits, and only the newest waiting text is sent. close() drops
 * whatever is still waiting and resolves once the edit in flight has landed, so a progress edit
 * can never overwrite the final answer.
 */
export function createProgress(send: (text: string) => Promise<unknown>, intervalMs: number) {
  let shown = "";
  let waiting = "";
  let lastSentAt = -Infinity;
  let sending: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function pump() {
    if (closed || sending || timer || waiting === shown) return;
    const wait = lastSentAt + intervalMs - Date.now();
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = undefined;
        pump();
      }, wait);
      return;
    }
    shown = waiting;
    sending = send(shown)
      .catch(() => {})
      .then(() => {
        sending = undefined;
        lastSentAt = Date.now();
        pump();
      });
  }

  return {
    set(text: string) {
      waiting = text;
      pump();
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      await sending;
    },
  };
}

const FENCE = "```";

/**
 * Splits `text` into messages of at most `max` characters, at a line break where one is near.
 * A code block cut in two is closed at the end of one message and reopened in the next.
 */
export function splitMessage(text: string, max = MESSAGE_MAX): string[] {
  const parts: string[] = [];
  // Leaves room to close a fence at the end of a message, or reopen one at its start.
  const room = max - FENCE.length - 1;
  let rest = text;
  while (rest.length > max) {
    const newline = rest.lastIndexOf("\n", room);
    const cut = newline > room / 2 ? newline : room;
    let part = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n/, "");
    // An odd number of fences leaves a code block open.
    if (part.split(FENCE).length % 2 === 0) {
      part += `\n${FENCE}`;
      rest = `${FENCE}\n${rest}`;
    }
    parts.push(part);
  }
  parts.push(rest);
  return parts;
}

/** How Slack writes a mention of a user in message text. */
const mentionOf = (userId: string | undefined) => `<@${userId}>`;

/** Whether the agent itself posted this message. */
const isOwnMessage = (m: SlackMessage, botUserId?: string) => botUserId !== undefined && m.user === botUserId;

const stripMention = (text: string, botUserId?: string) =>
  (botUserId ? text.replaceAll(mentionOf(botUserId), "") : text).trim();

/**
 * Prompt for a thread reply. Every run is a fresh VM with no memory, so the thread so far goes
 * in as a transcript. Always appends the latest message explicitly: conversations.replies
 * returns the oldest N messages, so on a long thread it can fall outside the window.
 */
export function buildTranscriptPrompt(messages: SlackMessage[], userMessage: string, botUserId?: string): string {
  const transcript = messages
    .filter((m) => Boolean(m.text))
    .map((m) => {
      const isBot = isOwnMessage(m, botUserId) || Boolean(m.bot_id);
      const text = stripMention(m.text ?? "", botUserId);
      return isBot ? `Agent: ${text}` : `${mentionOf(m.user)}: ${text}`;
    })
    .join("\n");

  return transcript
    ? `Conversation in this Slack thread so far:\n\n${transcript}\n\nRespond to this latest message: ${userMessage}`
    : userMessage;
}

/**
 * Decides which messages run the agent, checks access, and keeps each thread's replies in order.
 *
 * A DM, or a channel message that mentions the agent, runs it; everything else is ignored. Each
 * run is a fresh sandbox (run.ts), so a thread reply replays the thread's trusted history.
 *
 * Messages in one thread run strictly one after another, so answers keep the thread's order.
 * Different threads run in parallel, up to the runner's sandbox limit.
 */
export function createHandler({
  slack,
  runner,
  accessBundles,
  isAllowed,
  botUserId,
  log = console.log,
  progressIntervalMs = 1500,
}: HandlerOptions) {
  // Keyed by channel + thread_ts: a thread_ts is only unique within its channel.
  const queues = new Map<string, Promise<void>>();
  // Insertion-ordered, so the oldest entry is evicted first.
  const seen = new Set<string>();
  let stopped = false;

  const postInThread = ({ channel, threadTs }: IncomingMessage, text: string) =>
    slack.postMessage({ channel, thread_ts: threadTs, text });

  /** Runs the agent on one prompt and replaces the placeholder with its answer. */
  async function runAgent(message: IncomingMessage, key: string, userMessage: string) {
    const { channel, threadTs, isThreadReply } = message;
    const [history, placeholderTs] = await Promise.all([
      isThreadReply
        ? slack.replies({ channel, ts: threadTs }).catch((err) => {
            log(`Failed to fetch thread history: ${err}`);
            return undefined;
          })
        : undefined,
      postInThread(message, THINKING_TEXT)
        .then((r) => r.ts)
        .catch((err) => {
          log(`Failed to post thinking message: ${err}`);
          return undefined;
        }),
    ]);
    if (!placeholderTs) return;

    const prompt = buildTranscriptPrompt(await trustedHistory(history?.messages ?? []), userMessage, botUserId);
    log(`run: thread=${key}${isThreadReply ? " (with thread history)" : ""}`);

    const progress = createProgress((text) => slack.update({ channel, ts: placeholderTs, text }), progressIntervalMs);
    /**
     * Replaces the placeholder with the reply, once: from onAnswer, or after the run for a runner
     * that doesn't call it. A long reply continues in follow-up messages in the thread.
     */
    let posted: Promise<void> | undefined;
    const postReply = (text: string) =>
      (posted ??= (async () => {
        // Lands any edit in flight first, so it can't overwrite the reply.
        await progress.close();
        const [first, ...more] = splitMessage(text.trim() ? text : NO_ANSWER_REPLY);
        try {
          await slack.update({ channel, ts: placeholderTs, text: first });
        } catch (err) {
          log(`Failed to post reply on ${key}: ${err}`);
          // Never leave the placeholder showing progress for a run that has ended.
          await slack.update({ channel, ts: placeholderTs, text: ERROR_REPLY }).catch(() => {});
          return;
        }
        for (const part of more) {
          try {
            await postInThread(message, part);
          } catch (err) {
            log(`Failed to post the rest of the reply on ${key}: ${err}`);
            return;
          }
        }
      })());

    let narration: string | undefined;
    try {
      const answer = await runner.run(prompt, {
        accessBundles,
        onQueued: () => progress.set(QUEUED_TEXT),
        onStarted: () => progress.set(THINKING_TEXT),
        onEvent: (event) => {
          if (event.type === "narration") {
            // Shown only with the next tool call: text with no tool after it is the answer.
            narration = event.text;
          } else if (event.type === "tool") {
            progress.set(progressText(event, narration));
          }
        },
        // Posted while the runner revokes the session and deletes the sandbox.
        onAnswer: (text) => void postReply(text),
      });
      await postReply(answer);
    } catch (error) {
      log(`Agent error on ${key}: ${error instanceof Error ? error.message : String(error)}`);
      await postReply(ERROR_REPLY);
    }
  }

  /**
   * The thread history the agent may see: its own messages and those of people on the
   * allowlist. Anyone in the channel can post in a thread, so without this a stranger's text
   * (or another bot's) would reach the agent, and its shell, through the transcript.
   */
  async function trustedHistory(messages: SlackMessage[]): Promise<SlackMessage[]> {
    const trusted = await Promise.all(
      messages.map((m) => isOwnMessage(m, botUserId) || (!m.bot_id && isAllowed(m.user))),
    );
    return messages.filter((_, i) => trusted[i]);
  }

  /** Appends a task to the thread's queue; the returned promise resolves when it has run. */
  function enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const previous = queues.get(key) ?? Promise.resolve();
    // Never rejects, so one failure can't block the thread's later messages.
    const settled = previous.then(task).catch((err) => log(`Unhandled error on ${key}: ${err}`));
    queues.set(key, settled);
    settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
    return settled;
  }

  /**
   * Whether this copy of a message was already handled. Whether it mentions the agent is part of
   * the identity: a message edited to add a mention keeps its ts but must still run.
   */
  function isDuplicate({ channel, ts }: IncomingMessage, mentioned: boolean): boolean {
    if (!ts) return false;
    const id = `${channel}:${ts}:${mentioned}`;
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!);
    return false;
  }

  /** Handles one message; resolves once its reply is posted, and never rejects. */
  function handle(message: IncomingMessage): Promise<void> {
    const mentioned = Boolean(botUserId && message.text.includes(mentionOf(botUserId)));
    if (!message.isDm && !mentioned) return Promise.resolve();
    if (stopped) {
      log(`Stopping: ignored a message on ${message.channel}:${message.threadTs}`);
      return Promise.resolve();
    }
    if (isDuplicate(message, mentioned)) return Promise.resolve();
    const key = `${message.channel}:${message.threadTs}`;

    // Checked per message, not per thread: joining an allowed user's thread doesn't grant access.
    // Started on arrival so a refusal doesn't wait for a run in progress; allowed messages still
    // take their place in the queue, keeping the thread's order.
    // Never rejects: nothing awaits it until the thread's earlier messages are done, so a
    // rejection here would go unhandled and stop the process.
    const allowed = isAllowed(message.user)
      .then(async (ok) => {
        if (!ok) {
          log(`Denied ${message.user ?? "unknown user"} on ${key}`);
          await postInThread(message, NOT_ALLOWED_REPLY).catch((err) => log(`Failed to post refusal on ${key}: ${err}`));
        }
        return ok;
      })
      .catch((err) => {
        log(`Access check failed on ${key}: ${err}`);
        return false;
      });

    return enqueue(key, async () => {
      if (!(await allowed)) return;
      const userMessage = stripMention(message.text, botUserId);
      if (!userMessage) {
        await postInThread(message, EMPTY_MESSAGE_REPLY);
        return;
      }
      await runAgent(message, key, userMessage);
    });
  }

  /**
   * Ignores messages from now on and resolves once every message already taken has its reply.
   * Pair it with the runner's shutdown, so the runs in progress end promptly.
   */
  function stop(): Promise<unknown> {
    stopped = true;
    return Promise.allSettled(queues.values());
  }

  return { handle, stop };
}
