import { on } from "node:events";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { createJsonClient, HttpError } from "./http.js";
import type { ExecEvent, SandboxApi } from "./run.js";

/**
 * SPACE's native API, as verified in docs/contract.md. Management calls go to the API host with
 * the API token. A command's output and stdin go over a WebSocket on the data-plane host, using a
 * token scoped to that one command: stdin is the only channel that keeps the Agent Vault token out
 * of SPACE's records, since SPACE returns a command's argv from its process endpoints.
 */
export interface SpaceOptions {
  /** Management API origin, e.g. http://127.0.0.1:8080. */
  apiUrl: string;
  /** Data-plane origin, e.g. http://127.0.0.1:8090. Command attach URLs are relative to it. */
  dataPlaneUrl: string;
  apiToken: string;
  /** Per-request timeout for management calls. */
  timeoutMs?: number;
  /** Delay between polls of an operation. */
  pollIntervalMs?: number;
  /** How long delete waits for its operation to finish. */
  deleteTimeoutMs?: number;
  /**
   * Egress policy for every sandbox this client creates, replacing the template's deny-all
   * default. SPACE marks the field incubating. Unset sends none.
   */
  networkPolicy?: EgressPolicy;
}

/**
 * A SPACE egress policy that lets the VM reach only Agent Proxy. SPACE rules carry no port, so
 * this admits every port on that host; the Kubernetes NetworkPolicy narrows it to the proxy's.
 */
export function proxyOnlyEgressPolicy(proxyAddress: string): EgressPolicy {
  // host:port, with IPv6 in brackets as `agent-vault run --proxy` takes it; URL drops the port.
  const host = new URL(`http://${proxyAddress}`).hostname.replace(/^\[(.*)\]$/, "$1");
  return {
    version: "v1",
    egress: { default_action: "deny", allow: [isIP(host) ? { ip: host } : { domain: host }], deny: [] },
  };
}

export interface EgressPolicy {
  version: "v1";
  egress: { default_action: "deny" | "allow"; allow: object[]; deny: object[] };
}

interface Operation {
  kind: string;
  state: string;
  terminal_error_code: string | null;
  terminal_error: { message?: string } | null;
}

/** The data-plane frames this client acts on; others (attached, input_accepted, ...) are ignored. */
type ServerFrame =
  | { type: "process_started" }
  | { type: "stdout" | "stderr"; data_base64: string }
  | { type: "process_exited"; exit_code: number }
  | { type: "error"; code: string; message: string }
  | { type: "closed"; reason: string };

/** Operation states that end polling in failure; anything but these and "succeeded" is in progress. */
const FAILED_STATES = new Set(["failed", "canceled", "expired"]);

export function createSpace({
  apiUrl,
  dataPlaneUrl,
  apiToken,
  timeoutMs = 30_000,
  pollIntervalMs = 1000,
  deleteTimeoutMs = 60_000,
  networkPolicy,
}: SpaceOptions): SandboxApi & { exists(sandboxId: string): Promise<boolean> } {
  const dataPlane = new URL(dataPlaneUrl);
  const http = createJsonClient({
    baseUrl: `${apiUrl.replace(/\/+$/, "")}/v1`,
    headers: { authorization: `Bearer ${apiToken}` },
    timeoutMs,
    name: "SPACE",
    describeError(body) {
      try {
        const { code, message, request_id } = JSON.parse(body);
        if (code) return { code, detail: `${code}: ${message}${request_id ? ` (request ${request_id})` : ""}` };
      } catch {}
    },
  });
  /** A mutation. SPACE requires an Idempotency-Key on each; a fresh one per call is enough here. */
  const mutate = <T>(method: string, path: string, signal?: AbortSignal, body?: unknown) =>
    http<T>(method, path, { body, signal, headers: { "idempotency-key": randomUUID() } });

  /** Polls an operation until it succeeds; throws if it fails or `signal` aborts. */
  async function waitForOperation(operationId: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      // An operation is never done the moment it's accepted, so wait before the first poll too.
      await sleep(pollIntervalMs, undefined, { signal });
      const op = await http<Operation>("GET", `/operations/${encodeURIComponent(operationId)}`, { signal });
      if (op.state === "succeeded") return;
      if (FAILED_STATES.has(op.state)) {
        const reason = [op.terminal_error_code, op.terminal_error?.message].filter(Boolean).join(": ");
        throw new Error(`SPACE ${op.kind} ${op.state}${reason ? `: ${reason}` : ""}`);
      }
    }
  }

  /** Resolves a command's attach URL, refusing one off the data plane, where its token would leak. */
  function attachUrl(path: string): string {
    const url = new URL(path, dataPlane);
    if (url.origin !== dataPlane.origin) throw new Error(`SPACE attach URL ${url.origin} is not the data plane`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  }

  async function* exec(
    sandboxId: string,
    { command, stdin, signal }: { command: string; stdin: string; signal: AbortSignal },
  ): AsyncGenerator<ExecEvent> {
    const { attach } = await mutate<{ attach: { url: string; token: string } }>(
      "POST",
      `/sandboxes/${encodeURIComponent(sandboxId)}/commands`,
      signal,
      { command: ["sh", "-c", command], stdin: true },
    );
    const ws = new WebSocket(attachUrl(attach.url));
    const send = (frame: object) => ws.send(JSON.stringify(frame));
    ws.once("open", () => send({ type: "attach", token: attach.token }));

    // Output frames carry base64 bytes; a UTF-8 character can span two of them.
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    let exited = false;
    for await (const frame of frames(ws, signal)) {
      switch (frame.type) {
        case "process_started":
          // Input sent before this is refused with process_not_started. The process blocks reading
          // stdin until then, so it all goes in at once.
          if (stdin) send({ type: "input", seq: 0, data_base64: Buffer.from(stdin).toString("base64") });
          send({ type: "close_stdin", seq: stdin ? 1 : 0 });
          break;
        case "stdout":
        case "stderr": {
          const data = decoders[frame.type].decode(Buffer.from(frame.data_base64, "base64"), { stream: true });
          if (data) yield { type: frame.type, data };
          break;
        }
        case "process_exited":
          for (const type of ["stdout", "stderr"] as const) {
            const data = decoders[type].decode();
            if (data) yield { type, data };
          }
          exited = true;
          yield { type: "exit", code: frame.exit_code };
          break;
        case "error":
          throw new Error(`SPACE stream error ${frame.code}: ${frame.message}`);
        case "closed":
          if (!exited) throw new Error(`SPACE stream closed before the command exited: ${frame.reason}`);
          return;
      }
    }
  }

  return {
    async create(template, signal, onAccepted) {
      const { operation_id, sandbox_id } = await mutate<{ operation_id: string; sandbox_id: string }>(
        "POST",
        "/sandboxes",
        signal,
        {
          template,
          runtime: "firecracker",
          metadata: { app: "atlas" },
          ...(networkPolicy && { network_policy: networkPolicy }),
        },
      );
      onAccepted(sandbox_id);
      await waitForOperation(operation_id, signal);
      return { id: sandbox_id };
    },

    exec,

    /** False once SPACE answers 404, as it does from the moment a delete succeeds. */
    async exists(sandboxId) {
      try {
        await http("GET", `/sandboxes/${encodeURIComponent(sandboxId)}`);
        return true;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return false;
        throw err;
      }
    },

    async delete(sandboxId) {
      let operationId: string;
      try {
        ({ operation_id: operationId } = await mutate<{ operation_id: string }>(
          "DELETE",
          `/sandboxes/${encodeURIComponent(sandboxId)}`,
        ));
      } catch (err) {
        // Already gone: deleted earlier, or its create failed before it existed.
        if (err instanceof HttpError && err.status === 404) return;
        throw err;
      }
      await waitForOperation(operationId, AbortSignal.timeout(deleteTimeoutMs));
    },
  };
}

/** The socket's JSON frames, in order, until it closes. Aborting `signal` closes it and throws the reason. */
async function* frames(ws: WebSocket, signal: AbortSignal): AsyncGenerator<ServerFrame> {
  try {
    for await (const [data] of on(ws, "message", { signal, close: ["close"] })) yield JSON.parse(String(data));
  } catch (err) {
    // events.on wraps the abort reason in an AbortError; callers expect the reason itself.
    throw signal.aborted ? signal.reason : err;
  } finally {
    ws.terminate();
  }
}
