import { ModalClient, NotFoundError, type App, type Image, type Sandbox, type Secret } from "modal";

const NODE_IMAGE = "node:24-bookworm-slim";
// Keep the CLI at 0.45.13 or later: older versions call API routes that Infisical has removed.
const INFISICAL_CLI_VERSION = "0.45.13";
const CLAUDE_CODE_VERSION = "2.1.330";

/** The non-root user the agent runs as. Claude Code refuses bypassPermissions as root. */
export const SANDBOX_USER = "agent";
export const WORKSPACE_DIR = "/home/agent/workspace";

/** The proxy sidecar's name, which is also its hostname inside the sandbox. */
const PROXY_SIDECAR = "agent-proxy";
const PROXY_PORT = 17323;
export const PROXY_ADDRESS = `${PROXY_SIDECAR}:${PROXY_PORT}`;

/** Every sandbox carries these tags, so the startup sweep can find ones a crash left behind. */
const TAGS = { app: "team-assistant" };

/** A sandbox shuts itself down after this long with no command running. */
const IDLE_TIMEOUT_MS = 5 * 60_000;
/** Each sandbox lives at most the run timeout plus this, then Modal ends it. */
const SANDBOX_MARGIN_MS = 5 * 60_000;

// The proxy reads its token from INFISICAL_AGENT_VAULT_PROXY_TOKEN, never an argument, and loads its
// settings and certificate authority from Infisical, so every sidecar runs a copy of the same proxy.
const PROXY_COMMAND = `exec infisical agent-vault proxy --data-dir /tmp/proxy --port ${PROXY_PORT} --telemetry=false >/tmp/proxy.log 2>&1`;

// Polls until the proxy serves its certificate authority, for up to 30 seconds, or prints the end of its log.
const WAIT_FOR_PROXY = `node -e '
const deadline = Date.now() + 30000;
(async () => {
  for (;;) {
    const ok = await fetch("http://127.0.0.1:${PROXY_PORT}/_agent-vault/ca", { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    if (ok) process.exit(0);
    if (Date.now() > deadline) process.exit(1);
    await new Promise((r) => setTimeout(r, 200));
  }
})();' || { tail -n 20 /tmp/proxy.log; exit 1; }`;

export interface ExecResult {
  /** Each line of the command's stdout, as it arrives. */
  lines: AsyncIterable<string>;
  /** Resolves with the exit code and the end of stderr once the command finishes. */
  done: Promise<{ code: number; stderr: string }>;
}

/**
 * Modal sandboxes for the agent: one per message. The agent's container has no public egress, so its
 * only way out is the Agent Vault proxy running as a sidecar in the same sandbox, which only that
 * sandbox can reach. The proxy token goes to the sidecar alone, as a Modal Secret.
 */
export function createSandboxes({ modalAppName: appName, proxyToken, infisicalDomain, runTimeoutMs }: {
  modalAppName: string;
  proxyToken: string;
  infisicalDomain: string;
  runTimeoutMs: number;
}) {
  // Reads MODAL_TOKEN_ID and MODAL_TOKEN_SECRET, or else the active profile in ~/.modal.toml.
  const modal = new ModalClient();
  let app: Promise<App> | undefined;
  let image: Promise<Image> | undefined;
  let secret: Promise<Secret> | undefined;

  const getApp = () => (app ??= modal.apps.fromName(appName, { createIfMissing: true }));
  const getSecret = () => (secret ??= modal.secrets.fromObject({ INFISICAL_AGENT_VAULT_PROXY_TOKEN: proxyToken }));

  // Modal caches each layer by its commands, so the image builds once and later runs reuse it.
  const getImage = () =>
    (image ??= getApp().then((a) =>
      modal.images
        .fromRegistry(NODE_IMAGE)
        .dockerfileCommands([
          "RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git && rm -rf /var/lib/apt/lists/*",
          `RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @infisical/cli@${INFISICAL_CLI_VERSION} && npm cache clean --force`,
          `RUN useradd --create-home --shell /bin/bash ${SANDBOX_USER} && install -d -o ${SANDBOX_USER} -g ${SANDBOX_USER} ${WORKSPACE_DIR}`,
        ])
        .build(a),
    ));

  return {
    /** Builds the image ahead of the first message, which otherwise waits for it. */
    async prepare(): Promise<string> {
      return (await getImage()).imageId;
    },

    /** Creates a sandbox and starts its proxy sidecar. `onCreated` gets the ID as soon as it exists. */
    async create(onCreated: (sandbox: Sandbox) => void): Promise<Sandbox> {
      const [a, img, sec] = await Promise.all([getApp(), getImage(), getSecret()]);
      const sandbox = await modal.sandboxes.create(a, img, {
        timeoutMs: runTimeoutMs + SANDBOX_MARGIN_MS,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        cpu: 1,
        memoryMiB: 2048,
        tags: TAGS,
        // Empty blocks all public egress but leaves the sandbox's own sidecars reachable.
        outboundCidrAllowlist: [],
      });
      onCreated(sandbox);

      const proxy = await sandbox.experimentalSidecars.create(PROXY_SIDECAR, img, {
        command: ["sh", "-c", PROXY_COMMAND],
        env: { INFISICAL_DOMAIN: infisicalDomain },
        secrets: [sec],
      });
      const wait = await proxy.exec(["sh", "-c", WAIT_FOR_PROXY], { mode: "text", stdout: "pipe", stderr: "pipe" });
      const [log, code] = await Promise.all([wait.stdout.readText(), wait.wait()]);
      if (code !== 0) throw new Error(`The Agent Vault proxy didn't start in the sidecar: ${log.trim() || `exit ${code}`}`);
      return sandbox;
    },

    /**
     * Runs `script` with sh as the agent's user. `stdin` is written in full, then closed, so secrets
     * such as the session token go in there rather than in the command, which Modal records.
     */
    async exec(sandbox: Sandbox, script: string, stdin: string): Promise<ExecResult> {
      const proc = await sandbox.exec(["runuser", "-u", SANDBOX_USER, "--", "sh", "-c", script], {
        mode: "text",
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.stdin.writeText(stdin);
      await proc.stdin.close();

      let stderr = "";
      const stderrDone = (async () => {
        for await (const chunk of proc.stderr) stderr = (stderr + chunk).slice(-4000);
      })();

      async function* lines() {
        let buffer = "";
        for await (const chunk of proc.stdout) {
          buffer += chunk;
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            yield buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
          }
        }
        if (buffer) yield buffer;
      }

      return {
        lines: lines(),
        done: (async () => {
          const code = await proc.wait();
          await stderrDone;
          return { code, stderr };
        })(),
      };
    },

    async terminate(sandbox: Sandbox): Promise<void> {
      try {
        await sandbox.terminate({ wait: true });
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
      }
    },

    /** Terminates every tagged sandbox still running, such as ones a crash left behind. */
    async sweep(): Promise<number> {
      const { appId } = await getApp();
      let count = 0;
      for await (const sandbox of modal.sandboxes.list({ appId, tags: TAGS })) {
        await sandbox.terminate().catch((err) => {
          if (!(err instanceof NotFoundError)) throw err;
        });
        count++;
      }
      return count;
    },
  };
}

export type Sandboxes = ReturnType<typeof createSandboxes>;
