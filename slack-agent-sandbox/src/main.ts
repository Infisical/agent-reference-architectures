/**
 * Slack entry point: Socket Mode events in, gateway.ts does the work.
 *
 *   npm run start:slack     locally, through the SSH tunnel, with a separate dev Slack app
 *
 * Reads .env.local when present (see .env.example). On startup, cleans up any sessions and
 * sandboxes a previous process left behind before taking messages. On SIGINT or SIGTERM, stops
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
import { createSpace } from "./space.js";
import { createVault } from "./vault.js";

loadDotenv({ path: ".env.local", quiet: true });
const config = loadConfig();
const log = console.log;

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
    delete: (args) => app.client.chat.delete(args),
  },
  isAllowed: createAccessCheck({
    allowlist: parseAllowlist(config.slack.allowlist),
    lookupEmail: async (user) => memberEmail((await app.client.users.info({ user })).user, { teamId, enterpriseId }),
    log,
  }),
  accessBundles: [config.vault.defaultAccessBundle],
  botUserId,
  // config.space carries the egress policy that lets each sandbox reach only Agent Proxy.
  sandboxes: createSpace(config.space),
  sessions: createVault(config.vault).sessions,
  journal: createJournal(config.stateDir, log),
  harness: createClaudeHarness({ template: config.space.template, model: config.model }),
  instructions: readFileSync("instructions/AGENTS.md", "utf8"),
  proxyAddress: config.vault.proxyAddress,
  // loadConfig requires it for the bot.
  caFingerprint: config.vault.caFingerprint!,
  maxSandboxes: config.maxSandboxes,
  timeoutMs: config.runTimeoutMs,
  log,
});

// Before connecting, so nothing a crashed process left behind outlives this one's start.
await gateway.recover();

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
  `Atlas is running in Socket Mode (template=${config.space.template}, bundle=${config.vault.defaultAccessBundle}, ` +
    `max sandboxes=${config.maxSandboxes}, proxy CA ${config.vault.caFingerprint})`,
);
