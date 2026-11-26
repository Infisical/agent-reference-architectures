// Checks Modal and Agent Vault without Slack.
//   npm run smoke -- --preflight                         a sandbox, its proxy sidecar, and its network; no session
//   npm run smoke -- --as you@example.com "Say hello"    one paid run, on behalf of that person
import { loadConfig, loadEnv } from "./config.ts";
import { createSandboxes, PROXY_ADDRESS, SANDBOX_USER } from "./modal.ts";
import { createRunner } from "./run.ts";
import { createVault } from "./vault.ts";

loadEnv();
const config = loadConfig();
const sandboxes = createSandboxes(config);
const args = process.argv.slice(2);

if (args[0] === "--preflight") {
  console.log("Building the image (a few minutes the first time)…");
  console.log(`Image ${await sandboxes.prepare()}`);
  let sandbox;
  try {
    sandbox = await sandboxes.create((s) => console.log(`Sandbox ${s.sandboxId}`));
    console.log("The proxy sidecar is serving.");
    // Each check prints PASS or FAIL. The agent must not be root, must reach the proxy, and must reach nothing else.
    const probe = [
      `[ "$(id -un)" = ${SANDBOX_USER} ] && echo "PASS runs as ${SANDBOX_USER}" || echo "FAIL runs as $(id -un)"`,
      `curl -sf -m 10 http://${PROXY_ADDRESS}/_agent-vault/ca >/dev/null && echo "PASS reaches the proxy" || echo "FAIL can't reach the proxy"`,
      `curl -s -m 10 -o /dev/null https://example.com && echo "FAIL reaches the internet directly" || echo "PASS can't reach the internet directly"`,
    ].join("\n");
    const exec = await sandboxes.exec(sandbox, probe, "");
    let failed = false;
    for await (const line of exec.lines) {
      console.log(line);
      if (line.startsWith("FAIL")) failed = true;
    }
    await exec.done;
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (sandbox) await sandboxes.terminate(sandbox);
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
