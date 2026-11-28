import type { Config } from "./config.ts";

// Claude Code refuses bypassPermissions as root.
export const SANDBOX_USER = "agent";
export const WORKSPACE_DIR = "/home/agent/workspace";

// Keep the CLI at 0.45.13 or later: older versions call API routes that Infisical has removed.
export const INFISICAL_CLI_VERSION = "0.45.13";
export const CLAUDE_CODE_VERSION = "2.1.330";

export const IMAGE_COMMANDS = [
  "apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git iproute2 && rm -rf /var/lib/apt/lists/*",
  `npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @infisical/cli@${INFISICAL_CLI_VERSION} && npm cache clean --force`,
  `useradd --create-home --shell /bin/bash ${SANDBOX_USER} && install -d -o ${SANDBOX_USER} -g ${SANDBOX_USER} ${WORKSPACE_DIR}`,
];

export const sandboxTags = (config: Pick<Config, "deploymentName" | "sandboxRole">) => ({
  app: "team-assistant",
  deployment: config.deploymentName,
  role: config.sandboxRole,
});

export const SANDBOX_MARGIN_MS = 5 * 60_000;

export interface ExecResult {
  lines: AsyncIterable<string>;
  done: Promise<{ code: number; stderr: string }>;
}

export interface Sandboxes<H extends { id: string } = { id: string }> {
  prepare(): Promise<string>;
  create(onCreated: (sandbox: H) => void): Promise<H>;
  /** Secrets such as the session token go in `input`, never in `script`. */
  exec(sandbox: H, script: string, input: string): Promise<ExecResult>;
  /** Called before the session is revoked, so the proxy can upload the rest of the session logs. */
  stopProxy(sandbox: H): Promise<void>;
  terminate(sandbox: H): Promise<void>;
  sweep(): Promise<number>;
}

export async function createSandboxes(config: Config): Promise<Sandboxes> {
  if (config.sandboxProvider === "daytona") return (await import("./daytona.ts")).createDaytonaSandboxes(config);
  return (await import("./modal.ts")).createModalSandboxes(config);
}

export async function* splitLines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
    }
  }
  if (buffer) yield buffer;
}
