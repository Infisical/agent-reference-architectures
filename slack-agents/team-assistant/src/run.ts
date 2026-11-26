import type { Sandbox } from "modal";
import { parseStreamLine, progressLabel } from "./claude-stream.ts";
import type { Config } from "./config.ts";
import { PROXY_ADDRESS, WORKSPACE_DIR, type Sandboxes } from "./modal.ts";
import type { Vault } from "./vault.ts";

/** A session outlives its run's timeout by this much, so cleanup never races its expiry. */
const SESSION_MARGIN_MINUTES = 5;

export interface RunRequest {
  /** The Slack user's email: the session acts on behalf of the Infisical user with this email. */
  email: string;
  /** What the session log shows for this run. */
  label: string;
  prompt: string;
  /** Called if every sandbox is busy and the run has to wait. */
  onQueued?: () => void;
  onProgress?: (label: string) => void;
}

export const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * The script the agent's container runs. It holds no secrets: the session token is the first line of
 * stdin and the MCP config the second, and the rest of stdin is the prompt, which Claude Code reads.
 * `agent-vault run` points Claude Code at the proxy sidecar and checks the proxy's certificate
 * authority against the pinned fingerprint before Claude Code starts.
 */
export function bootstrapScript(config: Pick<Config, "prompt" | "caFingerprint" | "model">): string {
  const prompt = Buffer.from(config.prompt).toString("base64");
  const claude = [
    "env",
    // A placeholder: Claude Code refuses to start without a key, and the proxy attaches the real one.
    "ANTHROPIC_API_KEY=agent-vault",
    // Telemetry and update checks go to hosts outside the access bundle, which the proxy refuses.
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
    "DISABLE_AUTOUPDATER=1",
    "claude -p --output-format stream-json --verbose --permission-mode bypassPermissions",
    '--mcp-config "$MCP_CONFIG" --strict-mcp-config',
    // Its own memory would only write files that die with the sandbox.
    `--settings ${shellQuote(JSON.stringify({ autoMemoryEnabled: false }))}`,
    ...(config.model ? [`--model ${shellQuote(config.model)}`] : []),
    `--append-system-prompt "$(cat prompt.md)"`,
  ].join(" ");
  return [
    "set -eu",
    "IFS= read -r INFISICAL_AGENT_VAULT_SESSION_TOKEN",
    "export INFISICAL_AGENT_VAULT_SESSION_TOKEN",
    "IFS= read -r MCP_CONFIG",
    `cd ${WORKSPACE_DIR}`,
    `printf %s ${shellQuote(prompt)} | base64 -d > prompt.md`,
    `exec infisical agent-vault run --proxy ${PROXY_ADDRESS} --ca-fingerprint ${shellQuote(config.caFingerprint)} --telemetry=false -- ${claude}`,
  ].join("\n");
}

/** Hands out at most `max` slots. Callers past that wait in arrival order. */
function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    async acquire(onQueued?: () => void): Promise<() => void> {
      if (active < max) active++;
      else {
        onQueued?.();
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = waiting.shift();
        if (next) next();
        else active--;
      };
    },
  };
}

/**
 * Runs the agent once: a session on behalf of the person asking, a fresh sandbox, Claude Code in it,
 * then the session revoked and the sandbox terminated, whatever happened.
 */
export function createRunner({ config, vault, sandboxes }: { config: Config; vault: Vault; sandboxes: Sandboxes }) {
  const limiter = createLimiter(config.maxSandboxes);
  const script = bootstrapScript(config);
  const active = new Set<{ sessionId?: string; sandbox?: Sandbox }>();

  async function cleanUp(run: { sessionId?: string; sandbox?: Sandbox }) {
    await Promise.all([
      run.sessionId &&
        vault.revokeSession(run.sessionId).catch((err) => console.error(`Failed to revoke session ${run.sessionId}:`, err)),
      run.sandbox &&
        sandboxes.terminate(run.sandbox).catch((err) => console.error(`Failed to terminate ${run.sandbox?.sandboxId}:`, err)),
    ]);
  }

  return {
    async run({ email, label, prompt, onQueued, onProgress }: RunRequest): Promise<string> {
      const release = await limiter.acquire(onQueued);
      const run: { sessionId?: string; sandbox?: Sandbox } = {};
      active.add(run);
      try {
        // The session comes first: someone the delegation doesn't cover is refused before a sandbox starts.
        const session = await vault.startSession({
          email,
          ttlMinutes: config.runTimeoutMs / 60_000 + SESSION_MARGIN_MINUTES,
          label,
        });
        run.sessionId = session.id;
        await sandboxes.create((sandbox) => (run.sandbox = sandbox));

        const exec = await sandboxes.exec(run.sandbox!, script, `${session.token}\n${config.mcpConfig}\n${prompt}`);
        const timer = setTimeout(() => run.sandbox && void sandboxes.terminate(run.sandbox), config.runTimeoutMs);
        let answer: { text: string; isError: boolean } | undefined;
        try {
          for await (const line of exec.lines) {
            const event = parseStreamLine(line);
            if (event.kind === "tool") {
              const progress = progressLabel(event.tool);
              if (progress) onProgress?.(progress);
            } else if (event.kind === "result") {
              answer = event;
            }
          }
          const { code, stderr } = await exec.done;
          if (!answer || answer.isError) {
            throw new Error(
              `Claude Code finished without an answer (exit ${code})${answer?.text ? `: ${answer.text}` : ""}${stderr ? `\n${stderr.trim()}` : ""}`,
            );
          }
        } finally {
          clearTimeout(timer);
        }
        return answer.text;
      } finally {
        await cleanUp(run);
        active.delete(run);
        release();
      }
    },

    /** Revokes the sessions and terminates the sandboxes of runs still going, for a clean stop. */
    async stopAll(): Promise<void> {
      await Promise.all([...active].map(cleanUp));
    },
  };
}

export type Runner = ReturnType<typeof createRunner>;
