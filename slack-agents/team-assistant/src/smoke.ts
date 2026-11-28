// Checks the sandbox platform and Agent Vault without Slack.
//   npm run smoke -- --preflight                         a sandbox, its proxy, and its network; no session
//   npm run smoke -- --as you@example.com "Say hello"    one paid run, on behalf of that person
import { loadConfig, loadEnv } from "./config.ts";
import { createRunner } from "./run.ts";
import { createSandboxes, SANDBOX_USER } from "./sandbox.ts";
import { createVault } from "./vault.ts";

loadEnv();
const config = loadConfig();
const sandboxes = await createSandboxes(config);
const args = process.argv.slice(2);
console.log(`Sandbox platform: ${config.sandboxProvider}`);

if (args[0] === "--preflight") {
  console.log("Building the image (a few minutes the first time)…");
  console.log(`Image ${await sandboxes.prepare()}`);
  // Set as soon as the sandbox exists, so a failure partway through still cleans it up.
  let sandbox: { id: string } | undefined;
  try {
    await sandboxes.create((s) => {
      sandbox = s;
      console.log(`Sandbox ${s.id}`);
    });
    console.log("The proxy is serving.");
    const probe = [
      `[ "$(id -un)" = ${SANDBOX_USER} ] && echo "PASS runs as ${SANDBOX_USER}" || echo "FAIL runs as $(id -un)"`,
      `curl -sf -m 10 "http://$INFISICAL_AGENT_VAULT_PROXY_ADDRESS/_agent-vault/ca" >/dev/null && echo "PASS reaches the proxy" || echo "FAIL can't reach the proxy"`,
      `curl -s -m 10 -o /dev/null https://example.com && echo "FAIL reaches the internet directly" || echo "PASS can't reach the internet directly"`,
    ].join("\n");
    const exec = await sandboxes.exec(sandbox!, probe, "");
    let passed = 0;
    for await (const line of exec.lines) {
      console.log(line);
      if (line.startsWith("PASS")) passed++;
    }
    const { code, stderr } = await exec.done;
    // A probe that exits early prints no FAIL line either, so only a clean exit with every check passing counts.
    const ok = code === 0 && passed === probe.split("\n").length;
    if (!ok) console.log(`FAIL the probe exited with code ${code} after ${passed} passing check(s)${stderr ? `:\n${stderr.trim()}` : ""}`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    if (sandbox) {
      await sandboxes.stopProxy(sandbox).catch(() => {});
      await sandboxes.terminate(sandbox);
    }
    console.log("Sandbox terminated.");
  }
} else if (args[0] === "--as" && args[1] && args[2]) {
  const runner = createRunner({ config, vault: createVault(config), sandboxes });
  const answer = await runner.run({
    email: args[1],
    label: `Smoke test: ${args[2]}`,
    prompt: args[2],
    onProgress: (label) => console.log(label),
  });
  console.log(`\nAnswer:\n${answer}`);
  console.log("\nSession revoked and sandbox terminated.");
} else {
  console.error('Usage: npm run smoke -- --preflight\n       npm run smoke -- --as you@example.com "Say hello"');
  process.exitCode = 2;
}
