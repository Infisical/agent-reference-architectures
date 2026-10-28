import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { createClaudeHarness } from "./claude.js";
import { createGateway, toIncoming, type SlackEvent } from "./gateway.js";
import { ERROR_REPLY, NOT_ALLOWED_REPLY, THINKING_TEXT } from "./handler.js";
import { createJournal } from "./journal.js";
import {
  claudeOutput,
  claudeResult,
  claudeToolUse,
  FakeSandboxes,
  FakeSessions,
  FakeSlack,
  flush,
  hang,
  tempDir,
} from "./test-helpers/fakes.js";

const BOT = "UBOT";

/** Slack, the handler and the real runner, with SPACE and Agent Vault faked. */
function setup({ output, allowed = ["U1"] }: { output?: FakeSandboxes["output"]; allowed?: string[] } = {}) {
  const dir = tempDir("gateway-");
  const logs: string[] = [];
  const slack = new FakeSlack();
  const sandboxes = new FakeSandboxes(output ?? (() => claudeOutput([claudeToolUse, claudeResult("Here you go.")])));
  const sessions = new FakeSessions();
  const journal = createJournal(dir, (m) => logs.push(m));
  const gateway = createGateway({
    slack,
    isAllowed: async (user) => user !== undefined && allowed.includes(user),
    accessBundles: ["atlas"],
    progressIntervalMs: 0,
    botUserId: BOT,
    sandboxes,
    sessions,
    journal,
    harness: createClaudeHarness({ template: "coding-agent:v1" }),
    instructions: "Be brief.",
    proxyAddress: "10.0.0.5:17323",
    caFingerprint: "SHA256:AA:BB",
    maxSandboxes: 3,
    timeoutMs: 60_000,
    retryDelayMs: 0,
    replyGraceMs: 1000,
    log: (m) => logs.push(m),
  });
  /** Nothing left behind: every session revoked, every sandbox deleted, no run records. */
  const assertCleanedUp = () => {
    assert.equal(sessions.active.size, 0, "sessions left active");
    assert.equal(sandboxes.live.size, 0, "sandboxes left running");
    assert.deepEqual(readdirSync(dir), [], "run records left in the journal");
  };
  return { logs, slack, sandboxes, sessions, journal, gateway, assertCleanedUp };
}

const dm = (text: string, extra: Partial<SlackEvent> = {}): SlackEvent => ({
  user: "U1",
  text,
  channel: "D1",
  channel_type: "im",
  ts: "100.1",
  ...extra,
});
const channelMessage = (text: string, extra: Partial<SlackEvent> = {}): SlackEvent => ({
  user: "U1",
  text,
  channel: "C1",
  channel_type: "channel",
  ts: "200.1",
  ...extra,
});

async function until(condition: () => boolean) {
  for (let i = 0; i < 1000 && !condition(); i++) await flush();
  assert.ok(condition(), "condition never held");
}

test("toIncoming: a person's message, with its thread and whether it's a DM", () => {
  assert.deepEqual(toIncoming(dm("hi"), BOT), {
    user: "U1",
    text: "hi",
    channel: "D1",
    ts: "100.1",
    threadTs: "100.1",
    isThreadReply: false,
    isDm: true,
  });
  const reply = toIncoming(channelMessage("more", { thread_ts: "150.0" }), BOT);
  assert.equal(reply?.isDm, false);
  assert.equal(reply?.isThreadReply, true);
  assert.equal(reply?.threadTs, "150.0");
});

test("toIncoming: drops bots, the agent itself, and edits, deletions and joins", () => {
  assert.equal(toIncoming(dm("x", { bot_id: "B1" }), BOT), undefined);
  assert.equal(toIncoming(dm("x", { user: BOT }), BOT), undefined);
  assert.equal(toIncoming(dm("x", { user: undefined }), BOT), undefined);
  for (const subtype of ["message_changed", "message_deleted", "channel_join", "bot_message"]) {
    assert.equal(toIncoming(dm("x", { subtype }), BOT), undefined, subtype);
  }
  assert.ok(toIncoming(dm("x", { subtype: "file_share" }), BOT));
  assert.ok(toIncoming(channelMessage(`<@${BOT}> x`, { subtype: "thread_broadcast" }), BOT));
});

test("DM: one sandbox over the default bundle, progress in the thread, answer, then cleanup", async () => {
  const { slack, sandboxes, sessions, gateway, logs, assertCleanedUp } = setup();
  await gateway.receive(dm("list files"));

  assert.deepEqual(slack.posts, [{ channel: "D1", thread_ts: "100.1", text: THINKING_TEXT }]);
  assert.deepEqual(
    slack.updates.map((u) => u.text),
    [":hammer_and_wrench: Bash: List files", "Here you go."],
    "a progress edit, then the answer in the same message",
  );
  assert.ok(slack.updates.every((u) => u.channel === "D1" && u.ts === "ts-1"));

  assert.deepEqual(sessions.requests, [{ accessBundles: ["atlas"], ttl: "6m" }]);
  assert.deepEqual(sandboxes.log, ["create coding-agent:v1", "exec sb-1", "delete sb-1"]);
  assert.deepEqual(sessions.log, ["create sess-1", "revoke sess-1"]);
  const [exec] = sandboxes.execs;
  assert.match(exec.command, /--ca-fingerprint='SHA256:AA:BB'/, "the sandbox pins the proxy CA");
  assert.equal(exec.stdin, "agv_secret-1\nlist files", "token, then the prompt, on stdin only");
  assert.doesNotMatch(exec.command, /agv_/);
  assertCleanedUp();
  assert.ok(!logs.join("\n").includes("agv_"), "the token never reaches the logs");
});

test("the answer is in Slack before the session is revoked and the sandbox deleted", async () => {
  const { slack, sessions, gateway, assertCleanedUp } = setup();
  // Cleanup stalls until the reply is in Slack: had the reply waited for cleanup, it never would be.
  const revoke = sessions.revoke.bind(sessions);
  let shownBeforeRevoke = false;
  sessions.revoke = async (id) => {
    shownBeforeRevoke = await until(() => slack.updates.some((u) => u.text === "Here you go.")).then(
      () => true,
      () => false,
    );
    return revoke(id);
  };
  await gateway.receive(dm("list files"));

  assert.ok(shownBeforeRevoke, "the reply doesn't wait for cleanup");
  assert.equal(slack.updates.filter((u) => u.text === "Here you go.").length, 1, "posted once");
  assertCleanedUp();
});

test("channel: an @mention runs in its thread; a message without one runs nothing", async () => {
  const { slack, sandboxes, gateway, assertCleanedUp } = setup();
  await gateway.receive(channelMessage("just chatting"));
  await gateway.receive(channelMessage(`<@${BOT}> list files`, { ts: "300.1", thread_ts: "250.0" }));

  assert.equal(sandboxes.execs.length, 1);
  assert.equal(sandboxes.execs[0].stdin.split("\n").at(-1), "list files", "the mention is stripped");
  assert.deepEqual(slack.repliesCalls, [{ channel: "C1", ts: "250.0" }], "a thread reply fetches the thread");
  assert.deepEqual(slack.posts, [{ channel: "C1", thread_ts: "250.0", text: THINKING_TEXT }]);
  assert.equal(slack.updates.at(-1)?.text, "Here you go.");
  assertCleanedUp();
});

test("a mention delivered as both message and app_mention runs once", async () => {
  const { sandboxes, gateway } = setup();
  const event = channelMessage(`<@${BOT}> hi`);
  await Promise.all([gateway.receive(event), gateway.receive(event)]);
  assert.equal(sandboxes.execs.length, 1);
});

test("a user outside the allowlist is refused without minting a session or creating a sandbox", async () => {
  const { slack, sandboxes, sessions, gateway } = setup({ allowed: [] });
  await gateway.receive(dm("list files"));

  assert.deepEqual(slack.posts, [{ channel: "D1", thread_ts: "100.1", text: NOT_ALLOWED_REPLY }]);
  assert.deepEqual(sessions.requests, []);
  assert.deepEqual(sandboxes.log, []);
});

test("startup: recover() revokes and deletes what a crashed process left in the journal", async () => {
  const { sandboxes, sessions, journal, gateway, assertCleanedUp } = setup();
  journal.write({ runId: "crashed", startedAt: "earlier", sessionId: "sess-old", sandboxId: "sb-old" });
  await gateway.recover();

  assert.deepEqual(sessions.log, ["revoke sess-old"]);
  assert.deepEqual(sandboxes.log, ["delete sb-old"]);
  assertCleanedUp();
});

test("shutdown: aborts a run in progress, cleans it up, tells the thread, and takes no new messages", async () => {
  const { slack, sandboxes, sessions, gateway, assertCleanedUp } = setup({ output: (_stdin, signal) => hang(signal) });
  const handled = gateway.receive(dm("long task"));
  await until(() => sandboxes.execs.length === 1);

  await gateway.shutdown();
  await handled;
  assert.deepEqual(sessions.log, ["create sess-1", "revoke sess-1"]);
  assert.equal(slack.updates.at(-1)?.text, ERROR_REPLY, "the thread isn't left on Thinking...");
  assertCleanedUp();

  await gateway.receive(dm("another", { ts: "100.2" }));
  assert.equal(slack.posts.length, 1, "a message after shutdown gets no reply and no sandbox");
  assert.equal(sandboxes.execs.length, 1);
});
