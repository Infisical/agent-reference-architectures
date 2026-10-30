/**
 * End-to-end smoke test against Modal and Infisical, without Slack.
 *
 *   npm run smoke -- "Reply with AGENT_VAULT_OK"            one paid Claude Code run
 *   npm run smoke -- --expect AGENT_VAULT_OK "Reply with AGENT_VAULT_OK"
 *   npm run smoke -- --preflight --ungranted-bundle <slug>   no inference: session API and sandbox network checks
 *
 * Reads .env.local (see .env.example). Each run mints a short-lived Agent Vault session over
 * AGENT_VAULT_ACCESS_BUNDLE, runs in a fresh sandbox, and always revokes the session and deletes
 * the sandbox; the script then checks with Infisical and Modal that both are gone. Exits 1 if the
 * run failed or anything was left behind. Ctrl-C aborts the run and still cleans up.
 * Session tokens and identity credentials are never printed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { config as loadDotenv } from "dotenv";
import { createClaudeHarness } from "../src/claude.js";
import { loadConfig } from "../src/config.js";
import { createJournal, loadInstanceId } from "../src/journal.js";
import { createRunner } from "../src/run.js";
import {
  checkProbe,
  checkSessionApi,
  createProbeHarness,
  redact,
  runSmoke,
  type CleanupProbe,
  type ProbeReport,
} from "../src/smoke.js";
import { createModal, createModalClient, proxyFor } from "../src/modal.js";
import { createVault } from "../src/vault.js";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    preflight: { type: "boolean", default: false },
    expect: { type: "string" },
    timeout: { type: "string" },
    // An existing access bundle the identity isn't granted. A made-up name proves nothing: Infisical
    // refuses a missing bundle exactly as it refuses an ungranted one.
    "ungranted-bundle": { type: "string" },
  },
});

loadDotenv({ path: ".env.local", quiet: true });
const config = loadConfig(process.env, { slack: false });
// Everything printed goes through here, so redact is applied once, to all of it.
const log = (message: string) => console.log(redact(message));
const accessBundles = [config.vault.defaultAccessBundle];
const timeoutMs = Number(flags.timeout ?? (flags.preflight ? 3 : 5) * 60_000);
if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`--timeout must be milliseconds, got ${flags.timeout}`);
const ungrantedBundle = flags["ungranted-bundle"];
if (flags.preflight && !ungrantedBundle) {
  throw new Error("--preflight needs --ungranted-bundle <slug>: an existing access bundle the identity isn't granted");
}
const prompt = positionals.join(" ").trim() || (flags.preflight ? "preflight" : "");
if (!prompt) throw new Error('Pass a prompt, e.g. npm run smoke -- "Reply with AGENT_VAULT_OK", or --preflight');

const instructions = readFileSync("instructions/AGENTS.md", "utf8");
const vault = createVault(config.vault);
// Sandboxes reach Agent Proxy and nothing public, and get their own role and instance, so neither a
// bot's startup sweep nor another machine's smoke run terminates them.
const network = proxyFor(config.vault.proxy);
const sandboxes = createModal({
  ...config.modal,
  client: createModalClient(config.modal),
  network,
  role: "smoke",
  instance: loadInstanceId(join(config.stateDir, "smoke")),
  runTimeoutMs: timeoutMs,
});
// Resolved (or built) while the session checks run.
const preparing = sandboxes.prepare(config.modal.image);
// Awaited below; this only keeps an early failure from being reported as unhandled.
preparing.catch(() => {});
const harness = flags.preflight
  ? createProbeHarness(config.modal.image)
  : createClaudeHarness({ template: config.modal.image, model: config.model });
const runner = createRunner({
  sandboxes,
  sessions: vault.sessions,
  // Its own journal: recover() must never clean up a bot's in-flight runs in config.stateDir.
  journal: createJournal(join(config.stateDir, "smoke"), log),
  harness,
  instructions,
  proxyAddress: network.proxyAddress,
  caFingerprint: config.vault.caFingerprint,
  maxSandboxes: 1,
  timeoutMs,
  log,
});

const probe: CleanupProbe = { session: vault.getSession, sandboxExists: sandboxes.exists };

let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    log(`${signal}: aborting the run and cleaning up (again to quit at once)`);
    void runner.shutdown();
  });
}

const problems: string[] = [];
await runner.recover();

if (flags.preflight) {
  log(`Session API: minting a 1-minute session over [${accessBundles}]`);
  const api = await checkSessionApi(vault, accessBundles, ungrantedBundle!);
  log(
    api.problems.length
      ? `Session API FAILED: ${api.problems.join("; ")}`
      : `Session API: ok (session ${api.sessionId} minted, read, revoked twice; '${ungrantedBundle}' refused)`,
  );
  problems.push(...api.problems);
}

log(`Sandbox image ${config.modal.image} ready: ${await preparing}`);
log(`Running ${harness.name} in ${config.modal.image} over [${accessBundles}], timeout ${timeoutMs / 1000}s`);
const started = Date.now();
const result = await runSmoke({ runner, probe, prompt, accessBundles, expect: flags.expect, log });
log(`Finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (flags.preflight && result.answer) {
  const report = JSON.parse(result.answer) as ProbeReport;
  log(`Sandbox report: ${JSON.stringify(report)}`);
  problems.push(...checkProbe(report, { proxyAddress: network.proxyAddress, instructionsBytes: Buffer.byteLength(instructions) }));
  // Reported, not checked: Modal answers DNS even under an allowlist (docs/contract.md section 5).
  log(`Infisical Cloud from the sandbox: DNS ${report.infisicalDns ?? "doesn't resolve"}`);
} else if (result.answer !== undefined) {
  log(`Answer: ${result.answer}`);
}
if (result.error) problems.push(`run failed: ${result.error}`);

const { sessionIds, sandboxIds } = result.created;
log(`Sessions: ${sessionIds.join(", ") || "none"}; sandboxes: ${sandboxIds.join(", ") || "none"}`);
log(result.cleanupProblems.length ? `Cleanup FAILED: ${result.cleanupProblems.join("; ")}` : "Cleanup verified: sessions revoked, sandboxes deleted");
problems.push(...result.cleanupProblems);

log(problems.length ? `SMOKE FAILED\n- ${problems.join("\n- ")}` : "SMOKE PASSED");
process.exit(problems.length ? 1 : 0);
