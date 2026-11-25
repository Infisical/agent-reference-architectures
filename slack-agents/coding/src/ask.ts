// Asks the agent one question from the terminal, without Slack: npm run ask -- "What can you do?"
import { loadAgent } from "./config.ts";

const prompt = process.argv[2] ?? "What can you do?";
const agent = loadAgent();
const { runClaude } = await import("./run-claude.ts");
console.log(await runClaude(agent, prompt, (label) => console.error(label)));
