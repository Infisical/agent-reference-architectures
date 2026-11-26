// What the runner needs from a sandbox platform. Each message gets a fresh sandbox whose only way out
// is an Agent Vault proxy that nothing outside the run can reach. Modal and Daytona each implement it.
import type { Config } from "./config.ts";

/** The non-root user the agent runs as. Claude Code refuses bypassPermissions as root. */
export const SANDBOX_USER = "agent";
export const WORKSPACE_DIR = "/home/agent/workspace";

// Keep the CLI at 0.45.13 or later: older versions call API routes that Infisical has removed.
export const INFISICAL_CLI_VERSION = "0.45.13";
export const CLAUDE_CODE_VERSION = "2.1.330";

/** The commands that install the agent's tools, the same on every platform. */
export const IMAGE_COMMANDS = [
  "apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git iproute2 && rm -rf /var/lib/apt/lists/*",
  `npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @infisical/cli@${INFISICAL_CLI_VERSION} && npm cache clean --force`,
  `useradd --create-home --shell /bin/bash ${SANDBOX_USER} && install -d -o ${SANDBOX_USER} -g ${SANDBOX_USER} ${WORKSPACE_DIR}`,
];

/** Every sandbox carries this tag or label, so the startup sweep can find ones a crash left behind. */
export const SANDBOX_TAGS = { app: "team-assistant" };

/** Each sandbox lives at most the run timeout plus this, then the platform ends it. */
export const SANDBOX_MARGIN_MS = 5 * 60_000;

export interface ExecResult {
  /** Each line of the command's stdout, as it arrives. */
  lines: AsyncIterable<string>;
  /** Resolves with the exit code and the end of stderr once the command finishes. */
  done: Promise<{ code: number; stderr: string }>;
}

export interface Sandboxes<H extends { id: string } = { id: string }> {
  /** Builds the image or snapshot ahead of the first message, which otherwise waits for it. */
  prepare(): Promise<string>;
  /** Creates a sandbox with its proxy running. `onCreated` gets it as soon as there's something to clean up. */
  create(onCreated: (sandbox: H) => void): Promise<H>;
  /**
   * Runs `script` with sh as the agent's user, with `input` on stdin and INFISICAL_AGENT_VAULT_PROXY_ADDRESS
   * set to the proxy. Secrets such as the session token go in `input`, never in the command.
   */
  exec(sandbox: H, script: string, input: string): Promise<ExecResult>;
  /** Called before the session is revoked, so the proxy can upload the rest of the session logs. */
  stopProxy(sandbox: H): Promise<void>;
  terminate(sandbox: H): Promise<void>;
  /** Removes every tagged sandbox still running, such as ones a crash left behind. */
  sweep(): Promise<number>;
}

export async function createSandboxes(config: Config): Promise<Sandboxes> {
  if (config.sandboxProvider === "daytona") return (await import("./daytona.ts")).createDaytonaSandboxes(config);
  return (await import("./modal.ts")).createModalSandboxes(config);
}

/** Splits streamed text into lines. */
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
