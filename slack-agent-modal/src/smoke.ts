import { CREDENTIAL_PLACEHOLDER } from "./claude.js";
import { shellQuote, type Harness, type HarnessEvent } from "./harness.js";
import { INSTRUCTIONS_PATH, type Runner, type SessionApi } from "./run.js";
import type { SessionStatus } from "./vault.js";

/**
 * The end-to-end smoke test (scripts/smoke.ts): one prompt through the real runner, then proof
 * that its Agent Vault session was revoked and its sandbox deleted, whether the run passed or not.
 */

/** The IDs of every session and sandbox a run created, in the order they appeared. */
export interface Created {
  sessionIds: string[];
  sandboxIds: string[];
}

/** Collects problems; `fail(ok, problem)` records the problem unless `ok`. */
function problemList() {
  const problems: string[] = [];
  return { problems, fail: (ok: boolean, problem: string) => ok || problems.push(problem) };
}

/** Reads back what Infisical and Modal say about a resource after the run. */
export interface CleanupProbe {
  session(sessionId: string): Promise<Pick<SessionStatus, "status">>;
  /** False once the sandbox has finished or Modal no longer knows it. */
  sandboxExists(sandboxId: string): Promise<boolean>;
}

/** Problems with cleanup, empty when every session is revoked and every sandbox is gone. */
export async function verifyCleanup(created: Created, probe: CleanupProbe): Promise<string[]> {
  const problems: string[] = [];
  const check = async (what: string, task: () => Promise<string | undefined>) => {
    try {
      const problem = await task();
      if (problem) problems.push(problem);
    } catch (err) {
      problems.push(`${what}: could not check (${err instanceof Error ? err.message : err})`);
    }
  };
  await Promise.all([
    ...created.sessionIds.map((id) =>
      check(`session ${id}`, async () => {
        const { status } = await probe.session(id);
        return status === "revoked" ? undefined : `session ${id} is ${status}, not revoked`;
      }),
    ),
    ...created.sandboxIds.map((id) =>
      check(`sandbox ${id}`, async () => ((await probe.sandboxExists(id)) ? `sandbox ${id} still exists` : undefined)),
    ),
  ]);
  return problems;
}

/**
 * Masks anything shaped like a session token or URL credentials. The runner already masks the
 * run's own token; this is the script's backstop for anything else it prints.
 */
export const redact = (text: string) =>
  text.replace(/agv_[A-Za-z0-9_-]+/g, "agv_[redacted]").replace(/(\/\/[^/\s:@]+):[^@\s/]+@/g, "$1:[redacted]@");

export interface SmokeOptions {
  runner: Pick<Runner, "run">;
  probe: CleanupProbe;
  prompt: string;
  accessBundles: string[];
  /** Text the answer must contain. */
  expect?: string;
  log?: (message: string) => void;
}

export interface SmokeResult {
  answer?: string;
  /** Why the run failed, if it did. */
  error?: string;
  created: Created;
  /** Resources left behind; checked even when the run failed. */
  cleanupProblems: string[];
}

function describeEvent(event: HarnessEvent): string | undefined {
  if (event.type === "tool") return `tool: ${[event.name, event.detail].filter(Boolean).join(" ") || "(unnamed)"}`;
  if (event.type === "narration") return `agent: ${event.text.replace(/\s+/g, " ").slice(0, 200)}`;
  return undefined;
}

/** Runs one prompt, streaming its events to `log`, then checks that its resources are gone. */
export async function runSmoke({ runner, probe, prompt, accessBundles, expect, log = console.log }: SmokeOptions) {
  const created: Created = { sessionIds: [], sandboxIds: [] };
  const result: SmokeResult = { created, cleanupProblems: [] };
  try {
    result.answer = await runner.run(prompt, {
      accessBundles,
      onQueued: () => log("waiting for a sandbox slot"),
      onEvent: (event) => {
        const line = describeEvent(event);
        if (line) log(line);
      },
      onResources: ({ sessionId, sandboxId }) => {
        if (sessionId && !created.sessionIds.includes(sessionId)) created.sessionIds.push(sessionId);
        if (sandboxId && !created.sandboxIds.includes(sandboxId)) created.sandboxIds.push(sandboxId);
      },
    });
    if (expect !== undefined && !result.answer.includes(expect)) result.error = `the answer doesn't contain "${expect}"`;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  result.cleanupProblems = await verifyCleanup(created, probe);
  return result;
}

export interface VaultApi {
  sessions: SessionApi;
  getSession(sessionId: string): Promise<SessionStatus>;
}

/**
 * Exercises the session API with a one-minute session: mint, read it back active with the
 * requested bundles, revoke, read it back revoked, revoke again (idempotent). Then asks for
 * `ungrantedBundle` and expects Infisical to refuse it; a session it grants anyway is revoked.
 * Infisical refuses a bundle that doesn't exist the same way, so `ungrantedBundle` must be a real
 * bundle the identity isn't granted, or the check proves nothing.
 */
export async function checkSessionApi(vault: VaultApi, accessBundles: string[], ungrantedBundle: string) {
  const { problems, fail } = problemList();

  const session = await vault.sessions.create({ accessBundles, ttl: "1m" });
  try {
    fail(session.token.startsWith("agv_"), "the session token doesn't look like an Agent Vault token");
    const active = await vault.getSession(session.id);
    fail(active.status === "active", `a new session is ${active.status}, not active`);
    fail(active.expiresAt !== null, "a one-minute session has no expiry");
    const names = active.accessBundles.map((b) => b.name);
    fail(names.join() === accessBundles.join(), `the session carries [${names}], not [${accessBundles}]`);
  } finally {
    await vault.sessions.revoke(session.id);
  }
  const revoked = await vault.getSession(session.id);
  fail(revoked.status === "revoked" && revoked.revokedAt !== null, `a revoked session reads as ${revoked.status}`);
  await vault.sessions.revoke(session.id).catch((err) => problems.push(`revoking twice failed: ${err.message}`));

  try {
    const granted = await vault.sessions.create({ accessBundles: [ungrantedBundle], ttl: "1m" });
    await vault.sessions.revoke(granted.id);
    problems.push(`Infisical minted a session over '${ungrantedBundle}'; is the identity an Agent Vault admin?`);
  } catch (err) {
    fail(/HTTP 400 .*is granted to you/.test(String(err)), `asking for '${ungrantedBundle}' failed unexpectedly: ${err}`);
  }
  return { sessionId: session.id, problems };
}

/**
 * What the preflight probe reports from inside the sandbox, under `infisical agent-vault run`. The
 * proxy URL holds the session token, so only its host and whether it carries a password are kept.
 */
export interface ProbeReport {
  proxyHost: string | null;
  proxyHasCredentials: boolean;
  caTrusted: boolean;
  nodeUsesEnvProxy: boolean;
  /** Names of credential variables present in the agent's environment; should be empty. */
  credentialVars: string[];
  /** Whether a TLS handshake with Anthropic's address completes without the proxy. */
  anthropicDirect: { open: boolean; why?: string };
  /** Whether SSH on the proxy host answers: the proxy's host is allowed, but only its port should be. */
  proxyHostSsh: { open: boolean; why?: string };
  /** Reported, not checked: Modal sandboxes resolve DNS even when their egress is locked. */
  infisicalDns: string | null;
  /** The agent's uid: Claude Code refuses to bypass permissions as root (0). */
  uid: number;
  /** HTTP status of a free GET /v1/models through the proxy, or the error. */
  anthropicViaProxy: number | string;
  /** Size of the instructions file the bootstrap wrote, or null if it's missing. */
  instructionsBytes: number | null;
}

/** Anthropic's API address, tried directly in case DNS alone is what blocks it. */
const ANTHROPIC_API_IP = "160.79.104.10";

/**
 * Node script for the preflight: checks the environment `agent-vault run` set up, that direct
 * egress is blocked, and that a free Anthropic call works through the proxy. Prints one JSON line.
 */
const PROBE_JS = `
const instructionsPath = ${JSON.stringify(INSTRUCTIONS_PATH)};
const net = require("node:net"), tls = require("node:tls"), dns = require("node:dns/promises"), fs = require("node:fs");
// A sandbox network may accept a TCP connection before deciding (SPACE's gateway did), so a bare
// connect proves nothing: a destination counts as open only once it speaks (TLS completes, or a
// banner arrives).
const settle = (socket, event) => new Promise((resolve) => {
  const done = (open, why) => { socket.destroy(); resolve(why ? { open, why } : { open }); };
  socket.setTimeout(8000, () => done(false, "timeout"));
  socket.once(event, () => done(true));
  socket.once("error", (err) => done(false, err.code || err.message));
  socket.once("close", () => done(false, "closed"));
});
const tlsOpen = (host, servername) =>
  settle(tls.connect({ host, port: 443, servername, rejectUnauthorized: false }), "secureConnect");
const bannerOpen = (host, port) => settle(net.connect({ host, port }), "data");
const lookup = (host) => dns.lookup(host).then((a) => a.address, () => null);
const viaProxy = () =>
  fetch("https://api.anthropic.com/v1/models?limit=1", {
    headers: { "x-api-key": ${JSON.stringify(CREDENTIAL_PLACEHOLDER)}, "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(20000),
  }).then((res) => res.status, (err) => String((err.cause && (err.cause.code || err.cause.message)) || err.message));
(async () => {
  const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
  const ca = process.env.NODE_EXTRA_CA_CERTS;
  // Independent, so they run at once: the probe takes as long as its slowest check.
  const [anthropicDirect, proxyHostSsh, infisicalDns, anthropicViaProxy] = await Promise.all([
    tlsOpen(${JSON.stringify(ANTHROPIC_API_IP)}, "api.anthropic.com"),
    proxy ? bannerOpen(proxy.hostname, 22) : { open: false, why: "no proxy set" },
    lookup("app.infisical.com"),
    viaProxy(),
  ]);
  const report = {
    proxyHost: proxy ? proxy.host : null,
    proxyHasCredentials: Boolean(proxy && proxy.password),
    caTrusted: Boolean(ca && fs.existsSync(ca)),
    nodeUsesEnvProxy: process.env.NODE_USE_ENV_PROXY === "1",
    credentialVars: ["INFISICAL_UNIVERSAL_AUTH_CLIENT_ID", "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
      "INFISICAL_TOKEN", "INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN", "INFISICAL_AGENT_VAULT_ACCESS_BUNDLE",
      "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].filter((name) => process.env[name]),
    anthropicDirect,
    proxyHostSsh,
    infisicalDns,
    uid: process.getuid(),
    anthropicViaProxy,
    instructionsBytes: fs.existsSync(instructionsPath) ? fs.statSync(instructionsPath).size : null,
  };
  console.log(JSON.stringify({ probe: report }));
})();
`;

/**
 * A stand-in harness that runs PROBE_JS instead of an agent, through the same runner, bootstrap
 * and stdin token delivery, so the preflight exercises the real path without paid inference.
 */
export function createProbeHarness(template: string): Harness {
  return {
    name: "probe",
    template,
    command: () => `node -e ${shellQuote(PROBE_JS)}`,
    parseLine(line) {
      try {
        const { probe } = JSON.parse(line);
        if (probe) return [{ type: "final", text: JSON.stringify(probe) }];
      } catch {}
      return [];
    },
  };
}

/** Problems with a probe report, empty when the sandbox is set up the way the full run needs. */
/** What the probe's report should show: the proxy the sandbox was given and the instructions it was sent. */
export interface ProbeExpectations {
  proxyAddress: string;
  /** Byte length of instructions/AGENTS.md. */
  instructionsBytes: number;
}

export function checkProbe(report: ProbeReport, { proxyAddress, instructionsBytes }: ProbeExpectations): string[] {
  const { problems, fail } = problemList();
  fail(report.proxyHost === proxyAddress, `HTTPS_PROXY points at ${report.proxyHost}, not ${proxyAddress}`);
  fail(report.proxyHasCredentials, "HTTPS_PROXY carries no session credentials");
  fail(report.caTrusted, "NODE_EXTRA_CA_CERTS doesn't name the proxy's CA file");
  fail(report.nodeUsesEnvProxy, "NODE_USE_ENV_PROXY isn't 1");
  fail(report.credentialVars.length === 0, `credential variables in the agent's environment: ${report.credentialVars.join(", ")}`);
  fail(!report.anthropicDirect.open, `direct Anthropic access (${ANTHROPIC_API_IP}:443) is open`);
  fail(!report.proxyHostSsh.open, "SSH on the proxy host is reachable; only the proxy port should be");
  fail(report.uid !== 0, "the agent runs as root; Claude Code refuses to bypass permissions as root");
  fail(report.anthropicViaProxy === 200, `GET /v1/models through the proxy answered ${report.anthropicViaProxy}, not 200`);
  fail(
    report.instructionsBytes === instructionsBytes,
    `the bootstrap wrote ${report.instructionsBytes ?? "no"} bytes of instructions, not ${instructionsBytes}`,
  );
  return problems;
}
