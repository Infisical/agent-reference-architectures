// Starts the team assistant: npm start
import { loadConfig, loadEnv } from "./config.ts";
import { createSandboxes } from "./modal.ts";
import { createRunner } from "./run.ts";
import { startSlackBot } from "./slack.ts";
import { createVault } from "./vault.ts";

loadEnv();
const config = loadConfig();
const sandboxes = createSandboxes(config);
const runner = createRunner({ config, vault: createVault(config), sandboxes });

// Sandboxes a crash left behind still hold a session token, so they go before anything new starts.
const swept = await sandboxes.sweep();
if (swept) console.log(`Terminated ${swept} sandbox(es) left from an earlier run`);
console.log("Building the sandbox image (a few minutes the first time)…");
console.log(`Sandbox image ${await sandboxes.prepare()}`);

const app = await startSlackBot(config, runner);

let stopping = false;
async function stop(signal: string) {
  if (stopping) process.exit(1);
  stopping = true;
  console.log(`${signal}: revoking sessions and terminating sandboxes of runs in progress…`);
  await app.stop().catch(() => {});
  await runner.stopAll();
  process.exit(0);
}
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
