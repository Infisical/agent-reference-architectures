import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Agent {
  name: string;
  promptFile: string;
  mcpConfigFile?: string;
  workdir: string;
}

// slack.ts and run-claude.ts read the environment when they load, so import them after this runs.
export function loadAgent(): Agent {
  const dir = fileURLToPath(new URL("../", import.meta.url));
  if (existsSync(join(dir, ".env"))) process.loadEnvFile(join(dir, ".env"));

  // Outside this repo, so Claude Code doesn't load the repo's own CLAUDE.md files as instructions.
  const workdir = join(homedir(), "on-call-agent");
  mkdirSync(workdir, { recursive: true });

  return {
    name: "On-call agent",
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
