import { ModalClient, NotFoundError, type App, type Image, type Sandbox, type Secret } from "modal";
import type { Config } from "./config.ts";
import {
  IMAGE_COMMANDS,
  SANDBOX_MARGIN_MS,
  sandboxTags,
  SANDBOX_USER,
  splitLines,
  type ExecResult,
  type Sandboxes,
} from "./sandbox.ts";

const PROXY_SIDECAR = "agent-proxy";
const PROXY_PORT = 17323;
const PROXY_ADDRESS = `${PROXY_SIDECAR}:${PROXY_PORT}`;

const IDLE_TIMEOUT_MS = 5 * 60_000;

const PROXY_COMMAND = `exec infisical agent-vault proxy --data-dir /tmp/proxy --port ${PROXY_PORT} --telemetry=false >/tmp/proxy.log 2>&1`;

const WAIT_FOR_PROXY = `for i in $(seq 60); do curl -fs http://127.0.0.1:${PROXY_PORT}/_agent-vault/ca >/dev/null && exit 0; sleep 0.5; done; tail -n 20 /tmp/proxy.log; exit 1`;

type ModalSandbox = { id: string; sandbox: Sandbox };

export function createModalSandboxes(config: Config): Sandboxes<ModalSandbox> {
  const modal = new ModalClient();
  let app: Promise<App> | undefined;
  let image: Promise<Image> | undefined;
  let secret: Promise<Secret> | undefined;

  const getApp = () => (app ??= modal.apps.fromName(config.modalAppName, { createIfMissing: true }));
  const getSecret = () =>
    (secret ??= modal.secrets.fromObject({ INFISICAL_AGENT_VAULT_PROXY_TOKEN: config.proxyToken }));
  // Modal caches each layer by its commands, so the image builds once and later runs reuse it.
  const getImage = () =>
    (image ??= getApp().then((a) =>
      modal.images
        .fromRegistry("node:24-bookworm-slim")
        .dockerfileCommands(IMAGE_COMMANDS.map((command) => `RUN ${command}`))
        .build(a),
    ));

  return {
    async prepare() {
      return (await getImage()).imageId;
    },

    async create(onCreated) {
      const [a, img, sec] = await Promise.all([getApp(), getImage(), getSecret()]);
      const sandbox = await modal.sandboxes.create(a, img, {
        timeoutMs: config.runTimeoutMs + SANDBOX_MARGIN_MS,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        cpu: 1,
        memoryMiB: 2048,
        tags: sandboxTags(config),
        // Empty blocks all public egress but leaves the sandbox's own sidecars reachable.
        outboundCidrAllowlist: [],
      });
      const created = { id: sandbox.sandboxId, sandbox };
      onCreated(created);

      const proxy = await sandbox.experimentalSidecars.create(PROXY_SIDECAR, img, {
        command: ["sh", "-c", PROXY_COMMAND],
        env: { INFISICAL_DOMAIN: config.infisicalDomain },
        secrets: [sec],
      });
      const wait = await proxy.exec(["sh", "-c", WAIT_FOR_PROXY], { mode: "text", stdout: "pipe", stderr: "pipe" });
      const [log, code] = await Promise.all([wait.stdout.readText(), wait.wait()]);
      if (code !== 0) throw new Error(`The Agent Vault proxy didn't start in the sidecar: ${log.trim() || `exit ${code}`}`);
      return created;
    },

    async exec({ sandbox }, script, input): Promise<ExecResult> {
      const proc = await sandbox.exec(
        ["runuser", "-u", SANDBOX_USER, "--", "env", `INFISICAL_AGENT_VAULT_PROXY_ADDRESS=${PROXY_ADDRESS}`, "sh", "-c", script],
        { mode: "text", stdout: "pipe", stderr: "pipe" },
      );
      await proc.stdin.writeText(input);
      await proc.stdin.close();

      let stderr = "";
      const stderrDone = (async () => {
        for await (const chunk of proc.stderr) stderr = (stderr + chunk).slice(-4000);
      })();
      return {
        lines: splitLines(proc.stdout),
        done: (async () => {
          const code = await proc.wait();
          await stderrDone;
          return { code, stderr };
        })(),
      };
    },

    // Terminating the sandbox stops the sidecar with it.
    async stopProxy() {},

    async terminate({ sandbox }) {
      try {
        await sandbox.terminate({ wait: true });
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
      }
    },

    async sweep() {
      const { appId } = await getApp();
      let count = 0;
      for await (const sandbox of modal.sandboxes.list({ appId, tags: sandboxTags(config) })) {
        await sandbox.terminate().catch((err) => {
          if (!(err instanceof NotFoundError)) throw err;
        });
        count++;
      }
      return count;
    },
  };
}
