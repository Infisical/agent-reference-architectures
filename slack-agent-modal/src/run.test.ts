import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClaudeHarness } from "./claude.js";
import type { HarnessEvent } from "./harness.js";
import { createJournal } from "./journal.js";
import { bootstrapScript, createLimiter, createRunner, createStopwatch, describeStats, type ExecEvent } from "./run.js";
import { claudeOutput, claudeResult, claudeToolUse, deferred, FakeSandboxes, FakeSessions, flush, hang, tempDir } from "./test-helpers/fakes.js";

const harness = createClaudeHarness({ template: "builtin" });
const RUN = { accessBundles: ["coding-agent"] };

function setup(options: { output?: FakeSandboxes["output"]; maxSandboxes?: number; timeoutMs?: number } = {}) {
  const dir = tempDir("run-");
  const logs: string[] = [];
  const sandboxes = new FakeSandboxes(options.output ?? (() => claudeOutput([claudeToolUse, claudeResult("done")])));
  const sessions = new FakeSessions();
  const journal = createJournal(dir, (m) => logs.push(m));
  const runner = createRunner({
    sandboxes,
    sessions,
    journal,
    harness,
    instructions: "Be brief.",
    proxyAddress: "10.0.0.5:17323",
    maxSandboxes: options.maxSandboxes ?? 3,
    timeoutMs: options.timeoutMs ?? 60_000,
    log: (m) => logs.push(m),
    retryDelayMs: 0,
  });
  return { dir, logs, sandboxes, sessions, journal, runner };
}

/** Everything the orchestrator kept: run records and logs. Tokens must never appear in either. */
function persisted(dir: string, logs: string[]) {
  const files = readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8"));
  return [...files, ...logs].join("\n");
}

test("bootstrap script: token from the first stdin line, no secrets, agent under agent-vault run", () => {
  const instructions = "Be brief. Don't 'quote' me.\n";
  const script = bootstrapScript({ harness, instructions, proxyAddress: "10.0.0.5:17323", caFingerprint: "SHA256:abc" });
  assert.match(script, /^set -eu\nIFS= read -r INFISICAL_AGENT_VAULT_SESSION_TOKEN\n/);
  const written = script.match(/^printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > '\/home\/user\/workspace\/AGENTS\.md'$/m);
  assert.ok(written, "the script writes the instructions itself, with no separate exec");
  assert.equal(Buffer.from(written[1], "base64").toString(), instructions);
  assert.match(script, /INFISICAL_AGENT_VAULT_PROXY_ADDRESS='10\.0\.0\.5:17323'/);
  assert.match(
    script,
    /exec env HTTPS_PROXY=http:\/\/127\.0\.0\.1:9 HTTP_PROXY=http:\/\/127\.0\.0\.1:9 INFISICAL_DISABLE_UPDATE_CHECK=1 infisical agent-vault run --telemetry=false --ca-fingerprint='SHA256:abc' -- env ANTHROPIC_API_KEY=agent-vault-brokered .* claude -p /,
    "the CLI's own telemetry and update check fail fast instead of stalling on DNS",
  );
  assert.doesNotMatch(script, /agv_/);
  assert.doesNotMatch(bootstrapScript({ harness, instructions: "", proxyAddress: "p:1" }), /--ca-fingerprint/);
});

test("run: session and sandbox, exec, then revoke and delete; returns the answer", async () => {
  const { runner, sandboxes, sessions, dir, logs } = setup();
  const events: HarnessEvent[] = [];
  const answer = await runner.run("list files", { ...RUN, onEvent: (e) => events.push(e) });

  assert.equal(answer, "done");
  assert.deepEqual(events, [
    { type: "tool", name: "Bash", detail: "List files" },
    { type: "final", text: "done", stats: { durationMs: undefined, apiMs: undefined, turns: undefined } },
  ]);
  assert.match(
    logs.at(-1)!,
    /^run \S+ timings: wait for slot \d+\.\ds, session and boot \d+\.\ds, agent startup \d+\.\ds, agent run \d+\.\ds, cleanup \d+\.\ds$/,
  );
  assert.deepEqual(sessions.log, ["create sess-1", "revoke sess-1"]);
  assert.deepEqual(sandboxes.log, ["create builtin", "exec sb-1", "delete sb-1"], "the instructions need no separate command");
  // 60s timeout + 5 min margin.
  assert.deepEqual(sessions.requests, [{ accessBundles: ["coding-agent"], ttl: "6m" }]);
  assert.equal(sandboxes.live.size + sessions.active.size, 0);
  assert.deepEqual(readdirSync(dir), []);
  assert.ok(!persisted(dir, logs).includes("agv_"));
});

test("run: the session carries the bundles the caller chose for that run", async () => {
  const { runner, sessions, sandboxes } = setup();
  await runner.run("x", RUN);
  await runner.run("y", { accessBundles: ["read-only"] });
  assert.deepEqual(
    sessions.requests.map((r) => r.accessBundles),
    [["coding-agent"], ["read-only"]],
  );
  // The bundle is the orchestrator's choice: nothing about it goes into the VM.
  assert.ok(sandboxes.execs.every((e) => !e.command.includes("read-only") && !e.stdin.includes("read-only")));
});

test("run: no bundle means no session, sandbox or cleanup to do", async () => {
  const { runner, sessions, sandboxes } = setup();
  await assert.rejects(runner.run("x", { accessBundles: [] }), /at least one access bundle/);
  assert.deepEqual(sessions.log, []);
  assert.deepEqual(sandboxes.log, []);
});

test("run: the token reaches the sandbox only as the first stdin line, never in the command", async () => {
  const { runner, sandboxes } = setup();
  await runner.run("hello\nworld", RUN);
  const [exec] = sandboxes.execs;
  assert.equal(exec.stdin, "agv_secret-1\nhello\nworld");
  assert.ok(!exec.command.includes("agv_"));
  assert.ok(!exec.command.includes("hello"));
  assert.ok(sandboxes.log.every((entry) => !entry.includes("agv_")));
});

test("run: the token is masked in events, the answer and errors, even if the agent prints it", async () => {
  const echo = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "proxy agv_secret-1@host" }] } });
  const events: HarnessEvent[] = [];
  const { runner } = setup({ output: () => claudeOutput([echo, claudeResult("token agv_secret-1")]) });
  assert.equal(await runner.run("x", { ...RUN, onEvent: (e) => events.push(e) }), "token [session token]");
  assert.deepEqual(events[0], { type: "narration", text: "proxy [session token]@host" });

  const failing = setup({ output: () => [{ type: "stderr", data: "bad proxy agv_secret-1" }, { type: "exit", code: 1 }] });
  await assert.rejects(failing.runner.run("x", RUN), (err: Error) => !err.message.includes("agv_") && /\[session token\]/.test(err.message));
});

test("run: reports each resource's ID as it's created, before cleanup", async () => {
  const { runner, sandboxes } = setup();
  const seen: unknown[] = [];
  await runner.run("x", { ...RUN, onResources: (ids) => seen.push({ ...ids, live: sandboxes.live.size }) });
  // The session and sandbox are created together, so either may be reported first.
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.at(-1), { sessionId: "sess-1", sandboxId: "sb-1", live: 1 });
});

test("run: a refused session still deletes the sandbox booting alongside it", async () => {
  const { runner, sandboxes, sessions, dir } = setup();
  sessions.grants = [];
  await assert.rejects(runner.run("x", RUN), /No access bundle named 'coding-agent'/);
  assert.equal(sandboxes.execs.length, 0, "the agent never runs");
  assert.equal(sandboxes.live.size, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test("run: onAnswer gets the answer before the session is revoked and the sandbox deleted", async () => {
  const { runner, sandboxes, sessions } = setup();
  const at: string[] = [];
  const answer = await runner.run("x", {
    ...RUN,
    onAnswer: (text) => at.push(`${text} with ${sessions.active.size} session and ${sandboxes.live.size} sandbox`),
  });
  assert.equal(answer, "done");
  assert.deepEqual(at, ["done with 1 session and 1 sandbox"]);
  assert.equal(sessions.active.size + sandboxes.live.size, 0, "run() resolves only after cleanup");
});

test("run: a failed run never calls onAnswer", async () => {
  const { runner } = setup({ output: () => claudeOutput([claudeResult("half")], 1) });
  let called = false;
  await assert.rejects(runner.run("x", { ...RUN, onAnswer: () => (called = true) }), /exited with code 1/);
  assert.equal(called, false);
});

test("run: output split mid-line across chunks still parses", async () => {
  const line = claudeResult("split answer");
  const { runner } = setup({
    output: () => [
      { type: "stdout", data: line.slice(0, 10) },
      { type: "stdout", data: `${line.slice(10)}\n` },
      { type: "exit", code: 0 },
    ],
  });
  assert.equal(await runner.run("x", RUN), "split answer");
});

test("run: a non-zero exit fails with the stderr tail, and still cleans up", async () => {
  const { runner, sandboxes, sessions, dir } = setup({
    output: () => [{ type: "stderr", data: "\u001b[31mproxy refused\u001b[0m" }, { type: "exit", code: 2 }],
  });
  await assert.rejects(runner.run("x", RUN), /claude exited with code 2: proxy refused/);
  assert.equal(sandboxes.live.size + sessions.active.size, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test("run: a stream that ends before the exit status is an error, not a success", async () => {
  const { runner, sandboxes, sessions } = setup({ output: () => [{ type: "stdout", data: `${claudeResult("looks done")}\n` }] });
  await assert.rejects(runner.run("x", RUN), /stream ended before the command exited/);
  assert.equal(sandboxes.live.size + sessions.active.size, 0);
});

test("run: a stream that throws partway (disconnect) fails and cleans up", async () => {
  const { runner, sandboxes, sessions } = setup({
    output: async function* () {
      yield { type: "stdout", data: `${claudeToolUse}\n` } as ExecEvent;
      throw new Error("socket hang up");
    },
  });
  await assert.rejects(runner.run("x", RUN), /socket hang up/);
  assert.equal(sandboxes.live.size + sessions.active.size, 0);
});

test("run: exit 0 without a final answer is an error", async () => {
  const { runner } = setup({ output: () => claudeOutput([claudeToolUse]) });
  await assert.rejects(runner.run("x", RUN), /exited without a final answer/);
});

test("run: an error result from the agent fails the run", async () => {
  const error = JSON.stringify({ type: "result", is_error: true, errors: ["overloaded"] });
  const { runner } = setup({ output: () => claudeOutput([error], 1) });
  await assert.rejects(runner.run("x", RUN), /claude run failed: overloaded/);
});

test("run: a failed sandbox create still revokes the session", async () => {
  const { runner, sandboxes, sessions, dir } = setup();
  sandboxes.failCreate = new Error("no capacity");
  await assert.rejects(runner.run("x", RUN), /no capacity/);
  assert.deepEqual(sessions.log, ["create sess-1", "revoke sess-1"]);
  assert.deepEqual(readdirSync(dir), []);
});

test("run: a sandbox that fails to boot is journaled and still deleted", async () => {
  const { runner, sandboxes, sessions, dir } = setup();
  sandboxes.failBoot = new Error("boot failed");
  await assert.rejects(runner.run("x", RUN), /boot failed/);
  assert.deepEqual(sandboxes.log, ["create builtin", "delete sb-1"]);
  assert.deepEqual(sessions.log, ["create sess-1", "revoke sess-1"]);
  assert.deepEqual(readdirSync(dir), []);
});

test("run: timeout aborts the stream and cleans up", async () => {
  const { runner, sandboxes, sessions } = setup({ output: (_, signal) => hang(signal), timeoutMs: 20 });
  await assert.rejects(runner.run("x", RUN), /run timed out after 20ms/);
  assert.equal(sandboxes.live.size + sessions.active.size, 0);
});

test("cleanup: retries, and keeps the record when deletion keeps failing", async () => {
  const { runner, sandboxes, sessions, journal, logs } = setup();
  sessions.failRevokes = 1;
  sandboxes.failDeletes = 3;
  await runner.run("x", RUN);
  assert.deepEqual(sessions.log, ["create sess-1", "revoke sess-1", "revoke sess-1"]);
  assert.equal(sandboxes.log.filter((e) => e.startsWith("delete")).length, 3);
  const [record] = journal.list();
  assert.equal(record.sessionId, "sess-1");
  assert.equal(record.sandboxId, "sb-1");
  assert.ok(logs.some((m) => m.includes("kept for the next startup")));

  // The next startup finishes the job.
  await runner.recover();
  assert.deepEqual(journal.list(), []);
  assert.equal(sandboxes.live.size, 0);
});

test("recover: revokes and deletes everything a crashed process left in the journal", async () => {
  const { runner, sandboxes, sessions, journal } = setup();
  journal.write({ runId: "a", startedAt: "t", sessionId: "s-a", sandboxId: "b-a" });
  journal.write({ runId: "b", startedAt: "t", sessionId: "s-b" });
  await runner.recover();
  assert.deepEqual(sessions.log.sort(), ["revoke s-a", "revoke s-b"]);
  assert.deepEqual(sandboxes.log, ["delete b-a"]);
  assert.deepEqual(journal.list(), []);
});

test("recover: sweeps sandboxes the journal never saw, after the journal's cleanup", async () => {
  const { runner, sandboxes, journal, logs } = setup();
  journal.write({ runId: "a", startedAt: "t", sandboxId: "b-a" });
  sandboxes.sweep = async () => {
    sandboxes.log.push("sweep");
    return ["b-untracked"];
  };
  await runner.recover();
  assert.deepEqual(sandboxes.log, ["delete b-a", "sweep"]);
  assert.ok(logs.some((m) => m.includes("Terminated 1 untracked sandbox(es): b-untracked")));
});

test("run: never more sandboxes at once than the cap; waiting runs are told they're queued", async () => {
  const gates = [deferred(), deferred(), deferred()];
  let running = 0;
  let peak = 0;
  const { runner } = setup({
    maxSandboxes: 2,
    output: async function* (stdin) {
      running++;
      peak = Math.max(peak, running);
      await gates[Number(stdin.split("\n")[1])].promise;
      running--;
      yield* claudeOutput([claudeResult("done")]);
    },
  });
  const queued: number[] = [];
  const runs = [0, 1, 2].map((i) => runner.run(String(i), { ...RUN, onQueued: () => queued.push(i) }));
  await flush();
  await flush();
  assert.deepEqual(queued, [2]);
  assert.equal(running, 2);
  gates.forEach((g) => g.resolve());
  await Promise.all(runs);
  assert.equal(peak, 2);
});

test("shutdown: aborts runs in progress, waits for their cleanup, and refuses new ones", async () => {
  const { runner, sandboxes, sessions } = setup({ output: (_, signal) => hang(signal) });
  const running = runner.run("x", RUN);
  await flush();
  await flush();
  await runner.shutdown();
  await assert.rejects(running, /aborted: shutting down/);
  assert.equal(sandboxes.live.size + sessions.active.size, 0);
  await assert.rejects(runner.run("y", RUN), /shutting down/);
});

test("limiter: a released slot goes to the oldest waiter", async () => {
  const limiter = createLimiter(1);
  const order: string[] = [];
  const release = await limiter.acquire();
  const a = limiter.acquire().then((r) => (order.push("a"), r));
  const b = limiter.acquire().then((r) => (order.push("b"), r));
  release();
  (await a)();
  (await b)();
  assert.deepEqual(order, ["a", "b"]);
});

test("timings: laps between steps, and the agent's own account of its run", () => {
  let t = 0;
  const clock = createStopwatch(() => t);
  t = 1200;
  clock.lap("session");
  t = 35_250;
  clock.lap("boot");
  assert.equal(String(clock), "session 1.2s, boot 34.0s");
  assert.equal(describeStats({ durationMs: 21_300, apiMs: 17_940, turns: 2 }), "agent's own 21.3s, of which model API 17.9s, 2 turns");
  assert.equal(describeStats({ durationMs: 3759, turns: 1 }), "agent's own 3.8s, 1 turn");
  assert.equal(describeStats({}), "");
});

test("runner: refuses instructions too large to fit in one sh -c argument", () => {
  const { sandboxes, sessions, journal } = setup();
  assert.throws(
    () =>
      createRunner({
        sandboxes,
        sessions,
        journal,
        harness,
        instructions: "x".repeat(100_000),
        proxyAddress: "10.0.0.5:17323",
        maxSandboxes: 1,
        timeoutMs: 60_000,
      }),
    /bootstrap script is \d+ characters, over 100000/,
  );
});

test("run: a queued run is told when it gets its slot; one that never waited is not", async () => {
  const gate = deferred();
  const { runner } = setup({
    maxSandboxes: 1,
    output: async function* (stdin) {
      if (stdin.endsWith("first")) await gate.promise;
      yield* claudeOutput([claudeResult("done")]);
    },
  });
  const events: string[] = [];
  const callbacks = (name: string) => ({
    ...RUN,
    onQueued: () => events.push(`${name} queued`),
    onStarted: () => events.push(`${name} started`),
  });
  const first = runner.run("first", callbacks("first"));
  const second = runner.run("second", callbacks("second"));
  await flush();
  assert.deepEqual(events, ["second queued"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["second queued", "second started"]);
});

test("run: a journal error during cleanup still frees the sandbox slot", async () => {
  const { runner, journal, logs } = setup({ maxSandboxes: 1 });
  const remove = journal.remove;
  journal.remove = () => {
    throw new Error("disk full");
  };
  assert.equal(await runner.run("x", RUN), "done");
  assert.ok(logs.some((m) => m.includes("cleanup failed: disk full")));
  journal.remove = remove;
  assert.equal(await runner.run("y", RUN), "done", "the slot came back");
});
