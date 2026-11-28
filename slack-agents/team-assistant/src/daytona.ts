import { randomUUID } from "node:crypto";
import { Daytona, DaytonaNotFoundError, Image, type Sandbox } from "@daytona/sdk";
import type { Config } from "./config.ts";
import {
  CLAUDE_CODE_VERSION,
  IMAGE_COMMANDS,
  INFISICAL_CLI_VERSION,
  SANDBOX_MARGIN_MS,
  sandboxTags,
  SANDBOX_USER,
  type ExecResult,
  type Sandboxes,
} from "./sandbox.ts";

const PROXY_PORT = 17323;

/** Named after the versions it installs, so a version change builds a new snapshot. */
const SNAPSHOT = `team-assistant-claude-${CLAUDE_CODE_VERSION}-cli-${INFISICAL_CLI_VERSION}`.replaceAll(".", "-");

const GET_LINK_ADDRESS =
  "for i in $(seq 60); do ip -4 -o addr show eth1 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep . && exit 0; sleep 0.5; done; exit 1";

const STOP_PROXY =
  "pid=$(cat /tmp/proxy.pid); kill -TERM $pid; for i in $(seq 30); do kill -0 $pid 2>/dev/null || exit 0; sleep 0.5; done; exit 1";

const INPUT_FILE = "/tmp/run-input";

// Daytona sets HTTP_PROXY and HTTPS_PROXY in each sandbox, pointing at a proxy of its own that refuses
// these requests. The agent's sandbox can reach only the Agent Vault proxy, so they're removed first.
const WITHOUT_DAYTONA_PROXY = "env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u NO_PROXY -u no_proxy";

type DaytonaSandbox = { id: string; proxy: Sandbox; agent?: Sandbox; proxyAddress?: string };

export function createDaytonaSandboxes(config: Config): Sandboxes<DaytonaSandbox> {
  const daytona = new Daytona();
  let snapshot: Promise<void> | undefined;

  const ensureSnapshot = () =>
    (snapshot ??= (async () => {
      try {
        await daytona.snapshot.get(SNAPSHOT);
      } catch (err) {
        if (!(err instanceof DaytonaNotFoundError)) throw err;
        const image = Image.base("node:24-bookworm-slim").runCommands(...IMAGE_COMMANDS);
        await daytona.snapshot.create({ name: SNAPSHOT, image }, { onLogs: (line) => console.log(line.trimEnd()) });
      }
    })());

  return {
    async prepare() {
      await ensureSnapshot();
      return SNAPSHOT;
    },

    async create(onCreated) {
      await ensureSnapshot();
      const proxy = await daytona.create({
        snapshot: SNAPSHOT,
        ephemeral: true,
        labels: sandboxTags(config),
        ttlMinutes: Math.ceil((config.runTimeoutMs + SANDBOX_MARGIN_MS) / 60_000),
        envVars: { INFISICAL_AGENT_VAULT_PROXY_TOKEN: config.proxyToken, INFISICAL_DOMAIN: config.infisicalDomain },
      });
      // Deleting the proxy's sandbox also deletes the agent's sandbox linked to it.
      const created: DaytonaSandbox = { id: proxy.id, proxy };
      onCreated(created);
      await proxy.process.executeCommand(
        `nohup infisical agent-vault proxy --port ${PROXY_PORT} --telemetry=false > /tmp/proxy.log 2>&1 & echo $! > /tmp/proxy.pid`,
      );

      created.agent = await daytona.create({
        snapshot: SNAPSHOT,
        linkedSandbox: proxy.id,
        ephemeral: true,
        labels: sandboxTags(config),
        networkBlockAll: true,
      });
      const link = await proxy.process.executeCommand(GET_LINK_ADDRESS);
      if (link.exitCode !== 0) throw new Error("The proxy's sandbox didn't get an address on the linked network");
      const proxyIp = link.result.trim();
      // Blocking all traffic also blocks the proxy, so allow only the proxy's address.
      await created.agent.updateNetworkSettings({ networkAllowList: `${proxyIp}/32` });
      created.proxyAddress = `${proxyIp}:${PROXY_PORT}`;

      // The proxy serves only after it has loaded its settings from Infisical.
      const wait = await created.agent.process.executeCommand(
        `for i in $(seq 60); do ${WITHOUT_DAYTONA_PROXY} curl -fs http://${created.proxyAddress}/_agent-vault/ca >/dev/null && exit 0; sleep 0.5; done; exit 1`,
      );
      if (wait.exitCode !== 0) {
        const log = await proxy.process.executeCommand("tail -n 20 /tmp/proxy.log");
        throw new Error(`The Agent Vault proxy didn't start: ${log.result.trim()}`);
      }
      return created;
    },

    async exec({ agent, proxyAddress }, script, input): Promise<ExecResult> {
      if (!agent || !proxyAddress) throw new Error("The agent's sandbox isn't ready");
      // Daytona can't close a command's stdin, so the input goes in a file only the agent's user can
      // read, which the command opens as its stdin and deletes at once.
      await agent.fs.uploadFile(Buffer.from(input), INPUT_FILE);
      await agent.process.executeCommand(`chown ${SANDBOX_USER} ${INPUT_FILE} && chmod 600 ${INPUT_FILE}`);
      const wrapped = `exec < ${INPUT_FILE}; rm -f ${INPUT_FILE}\n${script}`;
      const command = `runuser -u ${SANDBOX_USER} -- ${WITHOUT_DAYTONA_PROXY} INFISICAL_AGENT_VAULT_PROXY_ADDRESS=${proxyAddress} sh -c ${shellQuote(wrapped)}`;

      const session = `run-${randomUUID()}`;
      await agent.process.createSession(session);
      const { cmdId } = await agent.process.executeSessionCommand(session, { command, runAsync: true });
      if (!cmdId) throw new Error("Daytona didn't return a command ID");

      const queue: string[] = [];
      let wake: (() => void) | undefined;
      let finished = false;
      let buffer = "";
      let stderr = "";
      const push = (line: string) => {
        queue.push(line);
        wake?.();
      };
      const streamed = agent.process
        .getSessionCommandLogs(
          session,
          cmdId,
          (chunk) => {
            buffer += chunk;
            let newline;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              push(buffer.slice(0, newline));
              buffer = buffer.slice(newline + 1);
            }
          },
          (chunk) => {
            stderr = (stderr + chunk).slice(-4000);
          },
        )
        .finally(() => {
          if (buffer) push(buffer);
          finished = true;
          wake?.();
        });

      async function* lines() {
        for (;;) {
          if (queue.length) yield queue.shift()!;
          else if (finished) return;
          else await new Promise<void>((resolve) => (wake = resolve));
        }
      }

      return {
        lines: lines(),
        done: (async () => {
          await streamed;
          const { exitCode } = await agent.process.getSessionCommand(session, cmdId);
          return { code: exitCode ?? -1, stderr };
        })(),
      };
    },

    async stopProxy({ proxy }) {
      await proxy.process.executeCommand(STOP_PROXY);
    },

    async terminate({ proxy }) {
      try {
        await proxy.delete();
      } catch (err) {
        if (!(err instanceof DaytonaNotFoundError)) throw err;
      }
    },

    async sweep() {
      let count = 0;
      for await (const sandbox of daytona.list({ labels: sandboxTags(config) })) {
        await sandbox.delete().catch((err) => {
          if (!(err instanceof DaytonaNotFoundError)) throw err;
        });
        count++;
      }
      return count;
    },
  };
}

const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
