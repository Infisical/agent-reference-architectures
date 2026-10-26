import type { Agent } from "./core/agent.ts";
import { startSlackBot } from "./core/slack.ts";

const name = process.env.AGENT?.trim().toLowerCase();
if (!name) throw new Error("Set AGENT to the agent to run, e.g. AGENT=jimmy");

// Each agent reads its own env when it loads, so only the chosen one is imported.
const { agent }: { agent: Agent } = await import(`./agents/${name}/index.ts`);
await startSlackBot(agent);
