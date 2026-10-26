// Ask an agent one question from the terminal, without Slack: npm run ask -- jimmy "What can you do?"
import type { Agent } from "./core/agent.ts";
import { runAgent } from "./core/run-agent.ts";

const [name, prompt = "What can you do?"] = process.argv.slice(2);
if (!name) throw new Error('Usage: npm run ask -- <agent> "<question>"');

const { agent }: { agent: Agent } = await import(`./agents/${name.toLowerCase()}/index.ts`);
console.log(await runAgent(agent, prompt, { onProgress: (p) => console.error(p) }));
