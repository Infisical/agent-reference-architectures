// Starts the agent as a Slack bot: npm start
import { loadAgent } from "./config.ts";

const agent = loadAgent();
const { startSlackBot } = await import("./slack.ts");
await startSlackBot(agent);
