import { setTimeout as sleep } from "node:timers/promises";
import { createHandler, type HandlerOptions, type IncomingMessage, type SlackMessage } from "./handler.js";
import { createRunner, type RunnerOptions } from "./run.js";

/** The Slack event fields the gateway reads, from a `message` or `app_mention` event. */
export interface SlackEvent extends SlackMessage {
  subtype?: string;
  channel: string;
  channel_type?: string;
  ts: string;
  thread_ts?: string;
}

// Subtypes that are still a person writing; the rest are edits, deletions, joins and bot posts.
const HUMAN_SUBTYPES = new Set(["thread_broadcast", "file_share"]);

/**
 * The message for the handler, or undefined for an event that isn't a person writing. Bots, the
 * agent included, are dropped, so it never answers itself or loops with another bot. Whether a
 * message runs the agent (a DM or a mention) is the handler's decision.
 */
export function toIncoming(event: SlackEvent, botUserId: string): IncomingMessage | undefined {
  if (event.bot_id || !event.user || event.user === botUserId) return undefined;
  if (event.subtype && !HUMAN_SUBTYPES.has(event.subtype)) return undefined;
  return {
    user: event.user,
    text: event.text ?? "",
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts ?? event.ts,
    isThreadReply: event.thread_ts !== undefined,
    isDm: event.channel_type === "im",
  };
}

export interface GatewayOptions
  extends Omit<RunnerOptions, "caFingerprint">,
    Pick<HandlerOptions, "slack" | "isAllowed" | "accessBundles" | "progressIntervalMs"> {
  botUserId: string;
  /** Required here: the bot runs unattended, so every sandbox pins the proxy's CA. */
  caFingerprint: string;
  /** How long shutdown waits, after the runs are cleaned up, for their replies to reach Slack. */
  replyGraceMs?: number;
}

/**
 * Slack events in, one sandbox run per message out (handler.ts and run.ts), independent of Bolt so
 * it can be tested with fakes. Call recover() before receiving events, and shutdown() on exit.
 */
export function createGateway({
  slack,
  isAllowed,
  accessBundles,
  progressIntervalMs,
  botUserId,
  replyGraceMs = 10_000,
  ...runnerOptions
}: GatewayOptions) {
  const runner = createRunner(runnerOptions);
  const handler = createHandler({ slack, runner, accessBundles, isAllowed, botUserId, progressIntervalMs, log: runnerOptions.log });

  /** Handles one event; resolves once its reply is posted, and never rejects. */
  function receive(event: SlackEvent): Promise<void> {
    const message = toIncoming(event, botUserId);
    return message ? handler.handle(message) : Promise.resolve();
  }

  /**
   * Aborts the runs in progress and waits for their sessions to be revoked and sandboxes deleted,
   * then gives their replies a moment to reach Slack. Messages after this are ignored.
   */
  async function shutdown(): Promise<void> {
    const replied = handler.stop();
    await runner.shutdown();
    await Promise.race([replied, sleep(replyGraceMs, undefined, { ref: false })]);
  }

  return { recover: runner.recover, receive, shutdown };
}
