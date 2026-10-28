import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { createClaudeHarness } from "./claude.js";
import { createJournal } from "./journal.js";
import { bootstrapScript, createRunner } from "./run.js";
import {
  checkProbe,
  checkSessionApi,
  createProbeHarness,
  redact,
  runSmoke,
  verifyCleanup,
  type ProbeReport,
} from "./smoke.js";
import { claudeOutput, claudeResult, FakeSandboxes, FakeSessions, hang, tempDir } from "./test-helpers/fakes.js";

const BUNDLES = ["coding-agent"];

function setup(options: { output?: FakeSandboxes["output"]; timeoutMs?: number } = {}) {
  const dir = tempDir("smoke-");
  const logs: string[] = [];
  const sandboxes = new FakeSandboxes(options.output ?? (() => claudeOutput([claudeResult("AGENT_VAULT_OK")])));
  const sessions = new FakeSessions();
  const runner = createRunner({
    sandboxes,
    sessions,
    journal: createJournal(dir, (m) => logs.push(m)),
    harness: createClaudeHarness({ template: "coding-agent:v1" }),
    instructions: "Be brief.",
    proxyAddress: "10.0.0.5:17323",
    maxSandboxes: 1,
    timeoutMs: options.timeoutMs ?? 60_000,
    log: (m) => logs.push(m),
    retryDelayMs: 0,
  });
  // Reads back the fakes' state, as the real probe asks Infisical and SPACE.
  const probe = { session: (id: string) => sessions.getSession(id), sandboxExists: async (id: string) => sandboxes.live.has(id) };
  const smoke = (overrides: Partial<Parameters<typeof runSmoke>[0]> = {}) =>
    runSmoke({
      runner,
      probe,
      prompt: "Reply with AGENT_VAULT_OK",
      accessBundles: BUNDLES,
      log: (m) => logs.push(m),
      ...overrides,
    });
  return { dir, logs, sandboxes, sessions, smoke };
}

test("smoke: a passing run returns the answer and verifies both resources are gone", async () => {
  const { smoke, sessions, dir } = setup();
  const result = await smoke({ expect: "AGENT_VAULT_OK" });
  assert.deepEqual(result, {
    answer: "AGENT_VAULT_OK",
    created: { sessionIds: ["sess-1"], sandboxIds: ["sb-1"] },
    cleanupProblems: [],
  });
  assert.deepEqual(sessions.requests.map((r) => r.accessBundles), [BUNDLES]);
  assert.deepEqual(readdirSync(dir), [], "nothing left in the journal");
});

test("smoke: tool calls and narration stream to the log", async () => {
  const tool = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "Checking." }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] },
  });
  const { smoke, logs } = setup({ output: () => claudeOutput([tool, claudeResult("done")]) });
  await smoke();
  assert.deepEqual(logs.filter((m) => /^(agent|tool):/.test(m)), ["agent: Checking.", "tool: Bash ls"]);
});

test("smoke: an answer without the expected text fails the smoke", async () => {
  const { smoke } = setup({ output: () => claudeOutput([claudeResult("something else")]) });
  const result = await smoke({ expect: "AGENT_VAULT_OK" });
  assert.match(result.error ?? "", /doesn't contain "AGENT_VAULT_OK"/);
  assert.deepEqual(result.cleanupProblems, []);
});

test("smoke: an execution error fails, and cleanup is still done and verified", async () => {
  const { smoke, sessions, sandboxes } = setup({
    output: () => [{ type: "stderr", data: "proxy refused" }, { type: "exit", code: 1 }],
  });
  const result = await smoke();
  assert.match(result.error ?? "", /claude exited with code 1: proxy refused/);
  assert.deepEqual(result.cleanupProblems, []);
  assert.equal(sessions.active.size + sandboxes.live.size, 0);
});

test("smoke: a timeout aborts the run, and cleanup is still done and verified", async () => {
  const { smoke, sessions, sandboxes } = setup({ output: (_, signal) => hang(signal), timeoutMs: 20 });
  const result = await smoke();
  assert.match(result.error ?? "", /timed out after 20ms/);
  assert.deepEqual(result.cleanupProblems, []);
  assert.equal(sessions.active.size + sandboxes.live.size, 0);
});

test("smoke: a revoke that keeps failing is reported, the sandbox is still deleted, and the record is kept", async () => {
  const { smoke, sessions, sandboxes, dir } = setup();
  sessions.failRevokes = 3;
  const result = await smoke();
  assert.equal(result.error, undefined, "the run itself passed");
  assert.deepEqual(result.cleanupProblems, ["session sess-1 is active, not revoked"]);
  assert.equal(sandboxes.live.size, 0);
  assert.equal(readdirSync(dir).length, 1, "kept so the next start retries it");
});

test("smoke: a sandbox that can't be deleted is reported", async () => {
  const { smoke, sandboxes } = setup();
  sandboxes.failDeletes = 3;
  const result = await smoke();
  assert.deepEqual(result.cleanupProblems, ["sandbox sb-1 still exists"]);
});

test("smoke: a sandbox that never boots is still tracked, deleted and verified", async () => {
  const { smoke, sandboxes } = setup();
  sandboxes.failBoot = new Error("boot failed");
  const result = await smoke();
  assert.match(result.error ?? "", /boot failed/);
  assert.deepEqual(result.created.sandboxIds, ["sb-1"]);
  assert.deepEqual(result.cleanupProblems, []);
});

test("smoke: no token reaches the log or the result, even if the agent echoes its proxy settings (the runner masks it)", async () => {
  const echo = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "HTTPS_PROXY=http://x-agent-vault:agv_secret-1@10.0.0.5:17323" }] },
  });
  const { smoke, logs, sandboxes } = setup({ output: () => claudeOutput([echo, claudeResult("token agv_secret-1")]) });
  const result = await smoke();
  const everything = [...logs, JSON.stringify(result)].join("\n");
  assert.ok(!everything.includes("agv_secret"), everything);
  assert.ok(!sandboxes.execs[0].command.includes("agv_"));
});

test("verifyCleanup: a lookup that fails is a problem, not a pass", async () => {
  const problems = await verifyCleanup(
    { sessionIds: ["s1"], sandboxIds: ["b1"] },
    {
      session: async () => Promise.reject(new Error("HTTP 503")),
      sandboxExists: async () => false,
    },
  );
  assert.deepEqual(problems, ["session s1: could not check (HTTP 503)"]);
});

test("redact: masks session tokens and URL passwords", () => {
  assert.equal(redact("t=agv_Ab-9_x."), "t=agv_[redacted].");
  assert.equal(redact("http://x-agent-vault:s3cret@10.0.0.1:1"), "http://x-agent-vault:[redacted]@10.0.0.1:1");
  assert.equal(redact("http://10.0.0.1:17323/path"), "http://10.0.0.1:17323/path");
});

/** Session API checks against FakeSessions, which refuses bundles outside its grants as Infisical does. */
function fakeVault(grants = BUNDLES) {
  const sessions = new FakeSessions();
  sessions.grants = grants;
  return { sessions, vault: { sessions, getSession: (id: string) => sessions.getSession(id) } };
}

test("checkSessionApi: mint, read, revoke twice, and an ungranted bundle refused", async () => {
  const { vault, sessions } = fakeVault();
  const { sessionId, problems } = await checkSessionApi(vault, BUNDLES, "admin-bundle");
  assert.deepEqual(problems, []);
  assert.equal((await sessions.getSession(sessionId)).status, "revoked");
  assert.deepEqual(sessions.log, ["create sess-1", "revoke sess-1", "revoke sess-1"], "the refused bundle minted nothing");
});

test("checkSessionApi: an identity that can mint any bundle is flagged, and that session revoked", async () => {
  const { vault, sessions } = fakeVault([...BUNDLES, "admin-bundle"]);
  const { problems } = await checkSessionApi(vault, BUNDLES, "admin-bundle");
  assert.match(problems.join(), /minted a session over 'admin-bundle'; is the identity an Agent Vault admin/);
  assert.equal(sessions.active.size, 0, "the session it shouldn't have minted is revoked");
});

const goodReport: ProbeReport = {
  proxyHost: "10.0.0.5:17323",
  proxyHasCredentials: true,
  caTrusted: true,
  nodeUsesEnvProxy: true,
  credentialVars: [],
  anthropicDirect: { open: false, why: "ECONNRESET" },
  proxyHostSsh: { open: false, why: "timeout" },
  infisicalDns: null,
  anthropicViaProxy: 200,
  instructionsBytes: 812,
};

test("checkProbe: a VM set up as the run needs passes; open egress or leaked credentials don't", () => {
  const expected = { proxyAddress: "10.0.0.5:17323", instructionsBytes: 812 };
  assert.deepEqual(checkProbe(goodReport, expected), []);
  const bad = checkProbe(
    {
      ...goodReport,
      anthropicDirect: { open: true },
      proxyHostSsh: { open: true },
      credentialVars: ["INFISICAL_TOKEN"],
      anthropicViaProxy: 407,
      instructionsBytes: null,
    },
    expected,
  );
  assert.equal(bad.length, 5);
  assert.match(bad.join("\n"), /wrote no bytes of instructions, not 812/);
  assert.match(checkProbe({ ...goodReport, instructionsBytes: 400 }, expected).join(), /wrote 400 bytes of instructions, not 812/);
  assert.match(bad.join("\n"), /SSH on the proxy host is reachable/);
  assert.match(bad.join("\n"), /direct Anthropic access .* is open/);
  assert.match(bad.join("\n"), /credential variables .*INFISICAL_TOKEN/);
  assert.match(bad.join("\n"), /answered 407/);
});

test("probe harness: runs under agent-vault run with no secrets, and reports one final line", () => {
  const harness = createProbeHarness("coding-agent:v1");
  const script = bootstrapScript({ harness, instructions: "x", proxyAddress: "10.0.0.5:17323" });
  assert.match(script, /INFISICAL_DISABLE_UPDATE_CHECK=1 infisical agent-vault run --telemetry=false -- node -e '/);
  assert.doesNotMatch(script, /agv_|AGENT_VAULT_ACCESS_BUNDLE=/);
  assert.deepEqual(harness.parseLine("banner"), []);
  assert.deepEqual(harness.parseLine(JSON.stringify({ probe: { a: 1 } })), [{ type: "final", text: '{"a":1}' }]);
});
