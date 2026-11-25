import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The agent this folder defines: its prompt.md and .env, and mcp.json if it uses MCP servers. */
export interface Agent {
  name: string;
  promptFile: string;
  /** The agent's mcp.json, or undefined when it has none. */
  mcpConfigFile?: string;
  /** Where Claude Code runs. The agent keeps its clone of the repo here between messages. */
  workdir: string;
}

/** Loads the folder's .env into the environment. Import slack.ts and run-claude.ts after this, since they read it. */
export function loadAgent(): Agent {
  const dir = fileURLToPath(new URL("../", import.meta.url));
  if (existsSync(join(dir, ".env"))) process.loadEnvFile(join(dir, ".env"));

  // Outside this repo, so Claude Code doesn't load the repo's own CLAUDE.md files as instructions.
  const workdir = join(homedir(), "coding-agent");
  mkdirSync(workdir, { recursive: true });

  return {
    name: "Coding agent",
    promptFile: join(dir, "prompt.md"),
    mcpConfigFile: existsSync(join(dir, "mcp.json")) ? join(dir, "mcp.json") : undefined,
    workdir,
  };
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
