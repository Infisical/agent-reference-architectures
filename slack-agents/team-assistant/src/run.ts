import { WORKSPACE_DIR, type Sandboxes } from "./sandbox.ts";
import { parseStreamLine, progressLabel } from "./claude-stream.ts";
import type { Config } from "./config.ts";
import type { Vault } from "./vault.ts";

// A session outlives its run's timeout by this much, so cleanup never races its expiry.
const SESSION_MARGIN_MINUTES = 5;

type Run = { sessionId?: string; sandbox?: { id: string } };

export interface RunRequest {
  email: string;
  label: string;
  prompt: string;
  onQueued?: () => void;
  onProgress?: (label: string) => void;
}

export const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

// Secrets come on stdin, never in the script: the session token, the MCP config, then the prompt.
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
    `exec infisical agent-vault run --ca-fingerprint ${shellQuote(config.caFingerprint)} --telemetry=false -- ${claude}`,
  ].join("\n");
}

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

export function createRunner({ config, vault, sandboxes }: { config: Config; vault: Vault; sandboxes: Sandboxes }) {
  const limiter = createLimiter(config.maxSandboxes);
  const script = bootstrapScript(config);
  const active = new Set<Run>();
  const pending = new Set<Promise<string>>();
  let stopping = false;
  const checkStopping = () => {
    if (stopping) throw new Error("The assistant is shutting down");
  };

  // The proxy stops first, so it uploads the rest of the session logs. Then the session is revoked
  // before the sandbox goes, so it ends even if terminating fails.
  async function cleanUp(run: Run) {
    if (run.sandbox) {
      await sandboxes.stopProxy(run.sandbox).catch((err) => console.error(`Failed to stop the proxy in ${run.sandbox?.id}:`, err));
    }
    if (run.sessionId) {
      await vault.revokeSession(run.sessionId).catch((err) => console.error(`Failed to revoke session ${run.sessionId}:`, err));
    }
    if (run.sandbox) {
      await sandboxes.terminate(run.sandbox).catch((err) => console.error(`Failed to terminate ${run.sandbox?.id}:`, err));
    }
  }

  async function runOnce({ email, label, prompt, onQueued, onProgress }: RunRequest): Promise<string> {
    checkStopping();
    const release = await limiter.acquire(onQueued);
    const run: Run = {};
    active.add(run);
    try {
      checkStopping();
      // The session comes first: someone the delegation doesn't cover is refused before a sandbox starts.
      const session = await vault.startSession({
        email,
        ttlMinutes: config.runTimeoutMs / 60_000 + SESSION_MARGIN_MINUTES,
        label,
      });
      run.sessionId = session.id;
      checkStopping();
      await sandboxes.create((sandbox) => (run.sandbox = sandbox));
      checkStopping();
      const mask = (text: string) => text.replaceAll(session.token, "[session token]");

      const exec = await sandboxes.exec(run.sandbox!, script, `${session.token}\n${config.mcpConfig}\n${prompt}`);
      const timer = setTimeout(() => {
        if (!run.sandbox) return;
        sandboxes.terminate(run.sandbox).catch((err) => console.error(`Failed to terminate ${run.sandbox?.id} after the timeout:`, err));
      }, config.runTimeoutMs);
      let answer: { text: string; isError: boolean } | undefined;
      try {
        for await (const line of exec.lines) {
          const event = parseStreamLine(mask(line));
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
            `Claude Code finished without an answer (exit ${code})${answer?.text ? `: ${answer.text}` : ""}${stderr ? `\n${mask(stderr).trim()}` : ""}`,
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
  }

  return {
    run(request: RunRequest): Promise<string> {
      const task = runOnce(request);
      pending.add(task);
      const forget = () => pending.delete(task);
      task.then(forget, forget);
      return task;
    },

    async stopAll(): Promise<void> {
      stopping = true;
      await Promise.all([...active].map(cleanUp));
      await Promise.allSettled([...pending]);
    },
  };
}

export type Runner = ReturnType<typeof createRunner>;
