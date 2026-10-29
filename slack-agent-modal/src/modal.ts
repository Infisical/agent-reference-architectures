import { isIP } from "node:net";
import { ModalClient, NotFoundError, type App, type Image, type Sandbox, type Volume } from "modal";
import { createPromiseCache } from "./cache.js";
import type { ProxyConfig } from "./config.js";
import { shellQuote } from "./harness.js";
import { resolveImage, SANDBOX_USER } from "./image.js";
import { RESOURCE_MARGIN_MS, type ExecEvent, type SandboxApi } from "./run.js";

/**
 * Modal Sandboxes behind the runner's SandboxApi, as described in docs/contract.md. Every sandbox
 * lives in one Modal App, is tagged with its `role` and `instance` so leaks can be found and swept, and gets
 * `network` (from proxyFor): its egress and, for a Volume proxy, an Agent Proxy sidecar. The Agent
 * Vault token reaches the sandbox only on a command's stdin: Modal shows a command's argv in its
 * dashboard, so nothing secret goes there.
 */
export interface ModalOptions {
  client: ModalClient;
  /** The Modal App every sandbox is created in; created if missing. */
  appName: string;
  /**
   * Who creates the sandboxes: the bot's startup sweep terminates only its own role's, so it never
   * touches a smoke run's.
   */
  role: "bot" | "smoke";
  /**
   * Who owns the sandboxes, from loadInstanceId on the journal's directory. The sweep terminates
   * only this instance's, so a second bot or smoke run on the same App keeps its sandboxes.
   */
  instance: string;
  /** The runner's timeout. Each sandbox lives this plus RESOURCE_MARGIN_MS, then Modal ends it. */
  runTimeoutMs: number;
  cpu: number;
  memoryMiB: number;
  network: Omit<SandboxNetwork, "proxyAddress">;
}

/** How a sandbox reaches Agent Proxy; from proxyFor. */
export interface SandboxNetwork {
  /**
   * Where the agent container may connect: IPv4 CIDRs only. Empty blocks all public egress but
   * leaves the sandbox's sidecars reachable.
   */
  outboundCidrAllowlist: string[];
  /** Agent Proxy's `host:port` as the agent dials it; for the runner. */
  proxyAddress: string;
  /** For a proxy run as a sidecar in each sandbox: the Volume holding its enrollment. */
  proxyVolume?: string;
}

/** The sidecar's name, which is also its hostname inside the sandbox, and the proxy's port. */
const PROXY_SIDECAR = "agent-proxy";
const PROXY_PORT = 17323;

/**
 * Starts Agent Proxy from a copy of the enrollment (proxy.json, and the CA that sandboxes pin), so
 * it never writes to the Volume every sandbox shares. With an enrollment present, the proxy
 * starts as that proxy without enrolling again; every sandbox runs a copy of the same proxy.
 */
const PROXY_COMMAND =
  "mkdir -p /tmp/proxy && cp -a /data/. /tmp/proxy/ && " +
  `exec infisical agent-vault proxy --data-dir /tmp/proxy --port ${PROXY_PORT} --telemetry=false >/tmp/proxy.log 2>&1`;

/**
 * Run in the sidecar, which uses the sandbox image (so it has Node): polls until the proxy serves
 * its CA, for up to 30 s, or prints the end of the proxy's log and fails.
 */
const PROXY_READY_JS = `
const deadline = Date.now() + 30000;
(async () => {
  for (;;) {
    const ok = await fetch("http://127.0.0.1:${PROXY_PORT}/_agent-vault/ca", { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    if (ok) process.exit(0);
    if (Date.now() > deadline) process.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
})();`;
const WAIT_FOR_PROXY = `node -e ${shellQuote(PROXY_READY_JS)} || { tail -n 5 /tmp/proxy.log; exit 1; }`;

/** A Modal client for the configured workspace token and environment. */
export function createModalClient({ tokenId, tokenSecret, environment }: { tokenId: string; tokenSecret: string; environment?: string }) {
  return new ModalClient({ tokenId, tokenSecret, environment });
}

/**
 * How sandboxes reach Agent Proxy. A proxy from a Volume runs as a sidecar in every sandbox
 * (createModal), which the agent reaches by its name while the empty allowlist blocks everything
 * public; nothing outside the sandbox can reach that proxy. A fixed proxy goes in the allowlist,
 * which takes IPv4 only; a CIDR carries no port, so the sandbox may reach every port on the
 * proxy's host. See docs/contract.md section 5.
 */
export function proxyFor(proxy: ProxyConfig): SandboxNetwork {
  if ("volume" in proxy) {
    return { outboundCidrAllowlist: [], proxyAddress: `${PROXY_SIDECAR}:${PROXY_PORT}`, proxyVolume: proxy.volume };
  }
  const match = proxy.address.match(/^([\d.]+):(\d{1,5})$/);
  if (!match || isIP(match[1]) !== 4 || Number(match[2]) > 65535) {
    throw new Error(`AGENT_VAULT_PROXY_ADDRESS must be an IPv4 address and port (Modal's allowlist takes IPv4 only), got "${proxy.address}"`);
  }
  return { outboundCidrAllowlist: [`${match[1]}/32`], proxyAddress: proxy.address };
}

/** A sandbox shuts itself down after this long with no running command, a backstop to the timeout. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export type ModalSandboxes = SandboxApi & {
  /** Resolves (building if needed) the image for `ref` ahead of the first run; returns its ID. */
  prepare(ref: string): Promise<string>;
  /** False once the sandbox has finished or Modal no longer knows it. */
  exists(sandboxId: string): Promise<boolean>;
  sweep(): Promise<string[]>;
};

export function createModal({
  client: modal,
  appName,
  role,
  instance,
  runTimeoutMs,
  cpu,
  memoryMiB,
  network: { outboundCidrAllowlist, proxyVolume },
}: ModalOptions): ModalSandboxes {
  const tags = { app: "apollo", role, instance };
  // Handles for sandboxes this process created: one from create already knows its task, so exec
  // on it skips the wait for the task ID that a handle from fromId pays.
  const handles = new Map<string, Sandbox>();
  // Each loaded once per process; a failure is retried on the next call.
  const apps = createPromiseCache<void, App>(async () => ({
    value: await modal.apps.fromName(appName, { createIfMissing: true }),
    ttlMs: Infinity,
  }));
  const app = () => apps.get();
  const images = createPromiseCache<string, Image>(async (ref) => {
    const [unbuilt, modalApp] = await Promise.all([resolveImage(modal, ref), app()]);
    return { value: await unbuilt.build(modalApp), ttlMs: Infinity };
  });
  const image = (ref: string) => images.get(ref);
  // The enrollment's Volume, read-only, for a proxy run as a sidecar in each sandbox.
  const volumes = proxyVolume
    ? createPromiseCache<void, Volume>(async () => ({
        value: (await modal.volumes.fromName(proxyVolume)).withMountOptions({ readOnly: true }),
        ttlMs: Infinity,
      }))
    : undefined;

  /**
   * Starts the proxy sidecar from the sandbox's own image, which already has the Infisical CLI the
   * bootstrap uses, and waits until it serves, so the agent's first request finds it.
   */
  async function startProxy(sandbox: Sandbox, modalImage: Image, volume: Volume) {
    const container = await sandbox.experimentalSidecars.create(PROXY_SIDECAR, modalImage, {
      command: ["sh", "-c", PROXY_COMMAND],
      volumes: { "/data": volume },
    });
    const wait = await container.exec(["sh", "-c", WAIT_FOR_PROXY], { mode: "text", stdout: "pipe", stderr: "pipe" });
    const [log, code] = await Promise.all([wait.stdout.readText(), wait.wait()]);
    if (code !== 0) throw new Error(`Agent Proxy didn't start in the sidecar: ${log.trim() || `exit ${code}`}`);
  }

  async function lookup(sandboxId: string): Promise<Sandbox> {
    return handles.get(sandboxId) ?? (await modal.sandboxes.fromId(sandboxId));
  }

  async function* exec(
    sandboxId: string,
    { command, stdin, signal }: { command: string; stdin: string; signal: AbortSignal },
  ): AsyncGenerator<ExecEvent> {
    signal.throwIfAborted();
    const sandbox = await wrap("exec", () => lookup(sandboxId));
    // Modal runs commands as root; Claude Code refuses to bypass permissions as root, and SPACE ran
    // the agent as an ordinary user. runuser keeps the environment and sets HOME to the user's.
    const proc = await wrap("exec", () =>
      sandbox.exec(["runuser", "-u", SANDBOX_USER, "--", "sh", "-c", command], { mode: "text", stdout: "pipe", stderr: "pipe" }),
    );

    const events = createChannel<ExecEvent>();
    // Stops reading once the runner stops consuming, as after an abort, so a process that keeps
    // writing until the sandbox is terminated doesn't fill the bot's memory.
    const pump = async (type: "stdout" | "stderr", stream: AsyncIterable<string>) => {
      for await (const data of stream) {
        if (events.ended) return;
        if (data) await events.push({ type, data });
      }
    };
    // The process blocks reading stdin until it arrives, so it all goes in at once, then EOF.
    const writeStdin = async () => {
      await proc.stdin.writeText(stdin);
      await proc.stdin.close();
    };
    Promise.all([writeStdin(), pump("stdout", proc.stdout), pump("stderr", proc.stderr)])
      .then(() => proc.wait())
      .then(
        (code) => {
          events.push({ type: "exit", code });
          events.close();
        },
        (err) => events.close(new Error(`Modal stream failed: ${message(err)}`)),
      );
    // On abort this rejects with the reason and stops reading; the runner then terminates the
    // sandbox, which ends the process and its streams.
    yield* events.drain(signal);
  }

  return {
    async prepare(ref) {
      // Also checks the proxy's Volume, so a missing one fails at startup.
      const [built] = await wrap("image build", () => Promise.all([image(ref), volumes?.get()]));
      return built.imageId;
    },

    /**
     * Modal's create resolves once the sandbox is running; there is no earlier accepted state
     * to report. It can't be cancelled either, so an abort during create still waits for it and
     * reports the ID, letting the runner clean it up rather than leaving it to the sandbox timeout.
     * The proxy sidecar starts after the ID is reported, so a sidecar failure is cleaned up too.
     */
    async create(ref, signal, onAccepted) {
      signal.throwIfAborted();
      const [modalApp, modalImage, volume] = await wrap("create", () => Promise.all([app(), image(ref), volumes?.get()]));
      signal.throwIfAborted();
      const sandbox = await wrap("create", () =>
        modal.sandboxes.create(modalApp, modalImage, {
          timeoutMs: runTimeoutMs + RESOURCE_MARGIN_MS,
          idleTimeoutMs: IDLE_TIMEOUT_MS,
          cpu,
          memoryMiB,
          tags,
          outboundCidrAllowlist,
        }),
      );
      handles.set(sandbox.sandboxId, sandbox);
      onAccepted(sandbox.sandboxId);
      signal.throwIfAborted();
      if (volume) {
        await wrap("proxy sidecar", () => startProxy(sandbox, modalImage, volume));
        signal.throwIfAborted();
      }
      return { id: sandbox.sandboxId };
    },

    exec,

    async exists(sandboxId) {
      try {
        return (await (await modal.sandboxes.fromId(sandboxId)).poll()) === null;
      } catch (err) {
        if (err instanceof NotFoundError) return false;
        throw err;
      }
    },

    async delete(sandboxId) {
      try {
        // Waits for the sandbox to stop: without it, terminate returns while poll() still reports
        // it running, so a cleanup check straight after sees it (seen live in the smoke test).
        await (await lookup(sandboxId)).terminate({ wait: true });
      } catch (err) {
        // Already gone: terminated earlier, or Modal no longer knows it.
        if (!(err instanceof NotFoundError)) throw new Error(`Modal terminate failed: ${message(err)}`);
      }
      handles.delete(sandboxId);
    },

    async sweep() {
      const { appId } = await app();
      const terminating: Promise<string>[] = [];
      for await (const sandbox of modal.sandboxes.list({ appId, tags })) {
        terminating.push(
          sandbox.terminate().then(
            () => sandbox.sandboxId,
            (err) => {
              if (err instanceof NotFoundError) return sandbox.sandboxId;
              throw new Error(`Modal terminate failed: ${message(err)}`);
            },
          ),
        );
      }
      return Promise.all(terminating);
    },
  };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs `task`, prefixing any error with the Modal operation it came from. */
async function wrap<T>(op: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (err) {
    throw new Error(`Modal ${op} failed: ${message(err)}`);
  }
}

/** Items a channel holds before `push` waits for the consumer to catch up. */
const CHANNEL_LIMIT = 256;

/**
 * A queue between producers and one async-iterating consumer. `drain` yields items in order,
 * then throws the error `close` was given, if any. Aborting its signal rejects with the reason.
 * `push` resolves once there is room, so a fast producer can't outrun the consumer without
 * limit. Once `drain` exits, the channel has `ended`: queued items are dropped and pushes ignored.
 */
export function createChannel<T>(limit = CHANNEL_LIMIT) {
  const items: T[] = [];
  let closed = false;
  let ended = false;
  let error: unknown;
  let wake: (() => void) | undefined;
  let waiting: (() => void)[] = [];
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const makeRoom = () => {
    const resume = waiting;
    waiting = [];
    for (const resolve of resume) resolve();
  };
  async function* read(signal: AbortSignal): AsyncGenerator<T> {
    for (;;) {
      signal.throwIfAborted();
      if (items.length) {
        const item = items.shift()!;
        if (items.length < limit) makeRoom();
        yield item;
        continue;
      }
      if (closed) {
        if (error !== undefined) throw error;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        wake = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
      });
    }
  }
  return {
    get ended() {
      return ended;
    },
    async push(item: T) {
      if (ended) return;
      items.push(item);
      notify();
      while (items.length >= limit && !ended) await new Promise<void>((resolve) => waiting.push(resolve));
    },
    close(err?: unknown) {
      closed = true;
      error = err;
      notify();
    },
    async *drain(signal: AbortSignal): AsyncGenerator<T> {
      try {
        yield* read(signal);
      } finally {
        ended = true;
        items.length = 0;
        makeRoom();
      }
    },
  };
}
