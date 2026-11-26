import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** This folder, where prompt.md and mcp.json live. */
export const AGENT_DIR = fileURLToPath(new URL("../", import.meta.url));

/** Loads the folder's .env into the environment. Call before reading any setting. */
export function loadEnv(): void {
  if (existsSync(join(AGENT_DIR, ".env"))) process.loadEnvFile(join(AGENT_DIR, ".env"));
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return value;
}

export interface Config {
  name: string;
  infisicalDomain: string;
  projectId: string;
  accessBundle: string;
  clientId: string;
  clientSecret: string;
  proxyToken: string;
  caFingerprint: string;
  /** Where each message runs: modal (the default) or daytona. */
  sandboxProvider: "modal" | "daytona";
  modalAppName: string;
  maxSandboxes: number;
  runTimeoutMs: number;
  model?: string;
  /** For the check on thread replies that don't mention the bot. Unset turns those replies off. */
  anthropicApiKey?: string;
  prompt: string;
  /** The MCP servers every run gets, as Claude Code's --mcp-config, with no credentials. */
  mcpConfig: string;
}

export function loadConfig(): Config {
  const mcpPath = join(AGENT_DIR, "mcp.json");
  return {
    name: process.env.AGENT_NAME?.trim() || "Team assistant",
    infisicalDomain: (process.env.INFISICAL_DOMAIN?.trim() || "https://app.infisical.com").replace(/\/+$/, ""),
    projectId: requireEnv("INFISICAL_AGENT_VAULT_PROJECT_ID"),
    accessBundle: process.env.AGENT_ACCESS_BUNDLE?.trim() || "team-assistant",
    clientId: requireEnv("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID"),
    clientSecret: requireEnv("INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET"),
    proxyToken: requireEnv("INFISICAL_AGENT_VAULT_PROXY_TOKEN"),
    caFingerprint: requireEnv("INFISICAL_AGENT_VAULT_CA_FINGERPRINT"),
    sandboxProvider: sandboxProvider(),
    modalAppName: process.env.MODAL_APP_NAME?.trim() || "team-assistant",
    maxSandboxes: numberEnv("MAX_SANDBOXES", 3),
    runTimeoutMs: numberEnv("RUN_TIMEOUT_MINUTES", 10) * 60_000,
    model: process.env.AGENT_MODEL?.trim() || undefined,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
    prompt: readFileSync(join(AGENT_DIR, "prompt.md"), "utf8"),
    mcpConfig: existsSync(mcpPath) ? JSON.stringify(JSON.parse(readFileSync(mcpPath, "utf8"))) : '{"mcpServers":{}}',
  };
}

function sandboxProvider(): Config["sandboxProvider"] {
  const value = process.env.SANDBOX_PROVIDER?.trim().toLowerCase() || "modal";
  if (value !== "modal" && value !== "daytona") throw new Error(`SANDBOX_PROVIDER must be modal or daytona, got "${value}"`);
  return value;
}
