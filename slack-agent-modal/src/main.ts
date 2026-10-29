/**
 * Slack entry point: Socket Mode events in, gateway.ts does the work.
 *
 *   npm run start:slack     locally, with a separate dev Slack app
 *
 * Reads .env.local when present (see .env.example). On startup, builds the sandbox image and
 * cleans up any sessions and sandboxes a previous process left behind before taking messages. On SIGINT or SIGTERM, stops
 * taking messages, aborts runs in progress, and revokes and deletes what they hold before exiting.
 */
import { readFileSync } from "node:fs";
import { App, webApi } from "@slack/bolt";
import { config as loadDotenv } from "dotenv";
import { createAccessCheck, memberEmail, parseAllowlist } from "./access.js";
import { createClaudeHarness } from "./claude.js";
import { loadConfig } from "./config.js";
import { createGateway, type SlackEvent } from "./gateway.js";
import { createJournal } from "./journal.js";
import { createModal, createModalClient, proxyFor } from "./modal.js";
import { createVault } from "./vault.js";

loadDotenv({ path: ".env.local", quiet: true });
const config = loadConfig();
const log = console.log;

// Each sandbox reaches Agent Proxy and nothing public; with a Volume, the proxy is its own sidecar.
const network = proxyFor(config.vault.proxy);
const sandboxes = createModal({ ...config.modal, client: createModalClient(config.modal), network, role: "bot", runTimeoutMs: config.runTimeoutMs });
// Built while the rest of startup runs and awaited before connecting, so the first message doesn't
// wait on it and a broken image fails here.
const preparing = sandboxes.prepare(config.modal.image);
// Awaited below; this only keeps an early failure from being reported as unhandled.
preparing.catch(() => {});

// One auth.test for everything: given botId and botUserId, Bolt skips its own.
const {
  bot_id: botId,
  user_id: botUserId,
  team_id: teamId,
  enterprise_id: enterpriseId,
} = await new webApi.WebClient(config.slack.botToken).auth.test();
if (!botUserId || !botId) throw new Error("Slack auth.test returned no bot user ID");
const app = new App({ token: config.slack.botToken, appToken: config.slack.appToken, socketMode: true, botId, botUserId });

const gateway = createGateway({
  slack: {
    postMessage: (args) => app.client.chat.postMessage(args),
    update: (args) => app.client.chat.update(args),
    replies: (args) => app.client.conversations.replies({ ...args, limit: 200 }),
  },
  isAllowed: createAccessCheck({
    allowlist: parseAllowlist(config.slack.allowlist),
    lookupEmail: async (user) => memberEmail((await app.client.users.info({ user })).user, { teamId, enterpriseId }),
    log,
  }),
  accessBundles: [config.vault.defaultAccessBundle],
  botUserId,
  sandboxes,
  sessions: createVault(config.vault).sessions,
  journal: createJournal(config.stateDir, log),
  harness: createClaudeHarness({ template: config.modal.image, model: config.model }),
  instructions: readFileSync("instructions/AGENTS.md", "utf8"),
  proxyAddress: network.proxyAddress,
  // loadConfig requires it for the bot.
  caFingerprint: config.vault.caFingerprint!,
  maxSandboxes: config.maxSandboxes,
  timeoutMs: config.runTimeoutMs,
  log,
});

// Before connecting, so nothing a crashed process left behind outlives this one's start. Only one
// bot runs per Modal App, so its sweep of bot-tagged sandboxes finds only leftovers.
await gateway.recover();
log(`Sandbox image ${config.modal.image} ready: ${await preparing}`);

// Not awaited: Bolt has already acked the event, and a run can take minutes.
const listen = async ({ event }: { event: unknown }) => {
  void gateway.receive(event as SlackEvent);
};
// DMs, through the message.im subscription.
app.event("message", listen);
// Channel messages that mention the agent. A mention that also arrives as a `message` event
// runs once: the handler drops the second copy.
app.event("app_mention", listen);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(130);
    stopping = true;
    log(`${signal}: finishing up; runs in progress are aborted and cleaned up (again to quit at once)`);
    // Aborting runs needn't wait for the socket to close: the gateway ignores new messages at once.
    void Promise.all([app.stop().catch((err) => log(`Failed to disconnect from Slack: ${err}`)), gateway.shutdown()]).then(
      () => process.exit(0),
    );
  });
}

await app.start();
log(
  `Apollo is running in Socket Mode (app=${config.modal.appName}, image=${config.modal.image}, ` +
    `bundle=${config.vault.defaultAccessBundle}, proxy=${network.proxyAddress}, ` +
    `max sandboxes=${config.maxSandboxes}, proxy CA ${config.vault.caFingerprint})`,
);
