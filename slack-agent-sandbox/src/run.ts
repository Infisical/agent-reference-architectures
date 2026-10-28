import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { shellQuote, type AgentStats, type Harness, type HarnessEvent } from "./harness.js";
import type { Journal, RunRecord } from "./journal.js";
import { createLineSplitter } from "./sse.js";

/** What a running command reports; space.ts maps SPACE's stream to these. */
export type ExecEvent = { type: "stdout"; data: string } | { type: "stderr"; data: string } | { type: "exit"; code: number };

/**
 * The SPACE operations a run needs (space.ts). Every call takes the run's signal and must reject
 * promptly once it aborts, including an exec stream blocked waiting for output.
 */
export interface SandboxApi {
  /**
   * Creates a sandbox from the template and resolves once it accepts commands. `onAccepted` gets
   * the ID as soon as SPACE assigns it, before the VM boots, so a crash while it boots can't lose it.
   * An abort before then still waits for that ID, so a sandbox SPACE made is never left untracked.
   */
  create(template: string, signal: AbortSignal, onAccepted: (sandboxId: string) => void): Promise<{ id: string }>;
  /** Runs `command` with `stdin` written and then closed, streaming its output until it exits. */
  exec(sandboxId: string, options: { command: string; stdin: string; signal: AbortSignal }): AsyncIterable<ExecEvent>;
  delete(sandboxId: string): Promise<void>;
}

/**
 * Agent Vault sessions (vault.ts). The caller names the access bundles, so which access a run
 * gets is decided per run by the orchestrator. Infisical refuses a bundle the identity isn't granted.
 */
export interface SessionApi {
  create(request: { accessBundles: string[]; ttl: string }): Promise<{ id: string; token: string }>;
  revoke(sessionId: string): Promise<void>;
}

/** Where the instructions file goes in the VM; the bootstrap runs the agent from its directory. */
const WORKSPACE_DIR = "/home/user/workspace";
export const INSTRUCTIONS_PATH = `${WORKSPACE_DIR}/AGENTS.md`;

/**
 * Keeps the Infisical CLI's own calls from stalling the start of every run. CLI v0.44.2 ignores
 * --telemetry=false (its PostHog client is built before flags are parsed) and checks GitHub for
 * updates, and the VM has no working DNS, so both used to wait out a timeout: about 10 s before the
 * agent started. With the CLI's proxy pointed at a closed local port they fail at once. The agent
 * never sees this proxy: agent-vault run replaces HTTP(S)_PROXY with Agent Proxy's for it, and
 * fetches the proxy's CA without a proxy (the preflight's caTrusted check fails if that changes).
 * Remove once the template's CLI honours --telemetry=false; see docs/contract.md section 4.
 */
const CLI_OFFLINE_ENV = "HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 INFISICAL_DISABLE_UPDATE_CHECK=1";

/**
 * Linux caps one argument at 128 KiB, and the whole script is one `sh -c` argument; past this
 * the instructions file needs another way into the VM.
 */
const MAX_SCRIPT_CHARS = 100_000;

export interface BootstrapOptions {
  harness: Harness;
  /** Contents of instructions/AGENTS.md, written into the VM by the script itself. */
  instructions: string;
  proxyAddress: string;
  caFingerprint?: string;
}

/**
 * The script run in the VM. It holds no secrets: the session token arrives as the first stdin
 * line, so it never appears in SPACE's command record, and `read` leaves the rest of stdin, the
 * prompt, for the agent. The instructions, which aren't secret, travel inside the script as base64,
 * so writing them costs no separate SPACE command. NODE_USE_ENV_PROXY makes Node's fetch honour
 * the proxy that `infisical agent-vault run` sets up; CLI_OFFLINE_ENV keeps the CLI's own calls off it.
 */
export function bootstrapScript({ harness, instructions, proxyAddress, caFingerprint }: BootstrapOptions): string {
  const ca = caFingerprint ? ` --ca-fingerprint=${shellQuote(caFingerprint)}` : "";
  const encoded = Buffer.from(instructions).toString("base64");
  return [
    "set -eu",
    "IFS= read -r INFISICAL_AGENT_VAULT_SESSION_TOKEN",
    "export INFISICAL_AGENT_VAULT_SESSION_TOKEN",
    `export INFISICAL_AGENT_VAULT_PROXY_ADDRESS=${shellQuote(proxyAddress)} NODE_USE_ENV_PROXY=1`,
    `cd ${shellQuote(WORKSPACE_DIR)}`,
    `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(INSTRUCTIONS_PATH)}`,
    `exec env ${CLI_OFFLINE_ENV} infisical agent-vault run --telemetry=false${ca} -- ${harness.command({ instructionsPath: INSTRUCTIONS_PATH })}`,
  ].join("\n");
}

/** Hands out at most `max` slots; callers past that wait in arrival order. */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    /** Resolves with a release function once a slot is free. `onQueued` runs if it had to wait. */
    async acquire(onQueued?: () => void): Promise<() => void> {
      if (active >= max) {
        onQueued?.();
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else {
        active++;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Hand the slot straight to the next waiter, so `active` never dips and lets a newcomer cut in.
        const next = waiting.shift();
        if (next) next();
        else active--;
      };
    },
  };
}

/** Milliseconds as seconds for the timings log, e.g. "21.3s". */
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Time spent in each step of a run, for the line logged when it ends. */
export function createStopwatch(now = Date.now) {
  let last = now();
  const laps: string[] = [];
  return {
    /** Records the time since the previous lap (or the start) under `name`. */
    lap(name: string) {
      const at = now();
      laps.push(`${name} ${seconds(at - last)}`);
      last = at;
    },
    toString: () => laps.join(", "),
  };
}

/** The agent's own account of its run, e.g. "agent's own 21.3s, of which model API 17.9s, 2 turns". */
export function describeStats({ durationMs, apiMs, turns }: AgentStats): string {
  const parts = [
    durationMs !== undefined && `agent's own ${seconds(durationMs)}`,
    apiMs !== undefined && `of which model API ${seconds(apiMs)}`,
    turns !== undefined && `${turns} turn${turns === 1 ? "" : "s"}`,
  ];
  return parts.filter(Boolean).join(", ");
}

export interface RunnerOptions {
  sandboxes: SandboxApi;
  sessions: SessionApi;
  journal: Journal;
  harness: Harness;
  /** Contents of instructions/AGENTS.md, written into each VM. */
  instructions: string;
  proxyAddress: string;
  caFingerprint?: string;
  maxSandboxes: number;
  timeoutMs: number;
  log?: (message: string) => void;
  /** Delay before the first cleanup retry; doubles each time. */
  retryDelayMs?: number;
}

export interface RunCallbacks {
  onEvent?: (event: HarnessEvent) => void;
  /** Called when every sandbox slot is taken and this run has to wait. */
  onQueued?: () => void;
  /** Called when a run that had to wait gets its slot. */
  onStarted?: () => void;
  /** Called with the run's resource IDs each time one is created, before any cleanup. */
  onResources?: (ids: Pick<RunRecord, "sessionId" | "sandboxId">) => void;
  /** Called with the answer as soon as the agent has exited with one, before the cleanup. */
  onAnswer?: (answer: string) => void;
}

export interface RunOptions extends RunCallbacks {
  /**
   * Access bundles the run's session carries, chosen by the orchestrator (v1: the configured
   * default). Never taken from the prompt or the VM, so the agent can't pick its own access.
   */
  accessBundles: string[];
}

const STDERR_TAIL_CHARS = 2000;
/** The longest line of agent output the runner buffers; a longer one fails the run. */
const MAX_LINE_CHARS = 16 * 1024 * 1024;
const CLEANUP_ATTEMPTS = 3;
/** Session lifetime beyond the run timeout, so it can't expire under a run that's still allowed. */
const SESSION_TTL_MARGIN_MS = 5 * 60 * 1000;

/**
 * Runs prompts in fresh sandboxes, one sandbox and one Agent Vault session per run. See run().
 * shutdown() aborts every run in progress and waits for their cleanup.
 */
export function createRunner({
  sandboxes,
  sessions,
  journal,
  harness,
  instructions,
  proxyAddress,
  caFingerprint,
  maxSandboxes,
  timeoutMs,
  log = console.log,
  retryDelayMs = 500,
}: RunnerOptions) {
  const limiter = createLimiter(maxSandboxes);
  const script = bootstrapScript({ harness, instructions, proxyAddress, caFingerprint });
  if (script.length > MAX_SCRIPT_CHARS) {
    throw new Error(`the bootstrap script is ${script.length} characters, over ${MAX_SCRIPT_CHARS}; shorten the instructions`);
  }
  const ttl = `${Math.ceil((timeoutMs + SESSION_TTL_MARGIN_MS) / 60_000)}m`;
  // Runs in progress, so shutdown can abort them and wait for their cleanup.
  const inFlight = new Map<AbortController, Promise<unknown>>();
  let shuttingDown = false;

  async function retry(what: string, task: () => Promise<void>): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        await task();
        return true;
      } catch (err) {
        log(`${what} failed (attempt ${attempt}/${CLEANUP_ATTEMPTS}): ${err instanceof Error ? err.message : err}`);
        if (attempt >= CLEANUP_ATTEMPTS) return false;
        await sleep(retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  /**
   * Revokes the session first, so the credential dies even if the sandbox outlives a failed
   * delete. The record is dropped only once both are gone; otherwise the next startup retries.
   */
  async function cleanup(record: RunRecord): Promise<void> {
    const { sessionId, sandboxId } = record;
    const revoked = !sessionId || (await retry(`Revoke session ${sessionId}`, () => sessions.revoke(sessionId)));
    const deleted = !sandboxId || (await retry(`Delete sandbox ${sandboxId}`, () => sandboxes.delete(sandboxId)));
    if (revoked && deleted) journal.remove(record.runId);
    else log(`Run ${record.runId} not fully cleaned up; kept for the next startup`);
  }

  /**
   * Streams the agent's output into events; returns its final answer. Throws unless it exits 0
   * with one. `token` is masked in every line and in the stderr, in case the agent echoes it.
   */
  async function execute(
    sandboxId: string,
    token: string,
    prompt: string,
    signal: AbortSignal,
    clock: ReturnType<typeof createStopwatch>,
    onEvent?: RunCallbacks["onEvent"],
  ) {
    const scrub = (text: string) => text.replaceAll(token, "[session token]");
    const lines = createLineSplitter(MAX_LINE_CHARS);
    let stderr = "";
    let exitCode: number | undefined;
    let final: Extract<HarnessEvent, { type: "final" }> | undefined;
    let started = false;
    const handle = (line: string) => {
      if (!line.trim()) return;
      for (const event of harness.parseLine(scrub(line))) {
        if (event.type === "final") final = event;
        onEvent?.(event);
      }
    };

    for await (const event of sandboxes.exec(sandboxId, { command: script, stdin: `${token}\n${prompt}`, signal })) {
      if (event.type === "stdout") {
        // The first output marks the agent up: the exec, agent-vault run and the CLI's own startup.
        // Meaningful for a harness that streams, as Claude Code does; one that prints only at the
        // end puts its whole run here.
        if (!started) {
          started = true;
          clock.lap("agent startup");
        }
        lines.push(event.data).forEach(handle);
      } else if (event.type === "stderr") stderr = (stderr + event.data).slice(-STDERR_TAIL_CHARS);
      else exitCode = event.code;
    }
    lines.end().forEach(handle);
    clock.lap("agent run");

    const detail = scrub(stripVTControlCharacters(stderr)).trim();
    const withStderr = (message: string) => (detail ? `${message}: ${detail}` : message);
    // No retry or replay in v1: a stream that ends without an exit status is a failed run.
    if (exitCode === undefined) throw new Error(withStderr("sandbox output stream ended before the command exited"));
    if (exitCode !== 0) throw new Error(withStderr(`${harness.name} exited with code ${exitCode}`));
    if (final === undefined) throw new Error(withStderr(`${harness.name} exited without a final answer`));
    return final;
  }

  /**
   * Runs one prompt: waits for a sandbox slot, mints a session over `accessBundles` while the
   * sandbox boots, runs the agent with the token and prompt on stdin, and streams its events.
   * Always revokes the session and deletes the sandbox afterwards. `onAnswer` gets the answer
   * before that cleanup; the returned promise resolves with it once cleanup is done.
   * The token lives only in locals: never logged, journaled or sent as an argument, and masked
   * in the agent's output before any of it leaves the runner.
   */
  async function run(prompt: string, { accessBundles, onEvent, onQueued, onStarted, onResources, onAnswer }: RunOptions): Promise<string> {
    if (shuttingDown) throw new Error("shutting down");
    if (!accessBundles.length) throw new Error("a run needs at least one access bundle");
    const clock = createStopwatch();
    let queued = false;
    const release = await limiter.acquire(() => {
      queued = true;
      onQueued?.();
    });
    if (queued) onStarted?.();
    clock.lap("wait for slot");
    // The agent's own timings, for the log line written once the run is cleaned up.
    let own = "";
    // The abort reason is the error the run rejects with.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`run timed out after ${timeoutMs}ms`)), timeoutMs);
    const record: RunRecord = { runId: randomUUID(), startedAt: new Date().toISOString() };
    const recordResources = () => {
      journal.write(record);
      onResources?.({ sessionId: record.sessionId, sandboxId: record.sandboxId });
    };

    const task = (async () => {
      try {
        if (shuttingDown) throw new Error("shutting down");
        // Minted while the sandbox boots. Each is recorded the moment it exists, and both settle
        // before anything else happens, so a failure on one side never leaves the other untracked.
        const minting = sessions.create({ accessBundles, ttl }).then(
          (session) => {
            record.sessionId = session.id;
            recordResources();
            log(`run ${record.runId}: session ${session.id}`);
            return session;
          },
          (err) => {
            // Stops the boot early; the abort reason is then this error.
            controller.abort(err);
            throw err;
          },
        );
        const booting = sandboxes.create(harness.template, controller.signal, (sandboxId) => {
          record.sandboxId = sandboxId;
          recordResources();
        });
        await Promise.allSettled([minting, booting]);
        const [session, sandbox] = await Promise.all([minting, booting]);
        clock.lap("session and boot");
        log(`run ${record.runId}: sandbox ${sandbox.id} (${harness.template})`);

        const final = await execute(sandbox.id, session.token, prompt, controller.signal, clock, onEvent);
        own = describeStats(final.stats ?? {});
        // Before cleanup, so the reply doesn't wait on revoke and delete.
        onAnswer?.(final.text);
        return final.text;
      } catch (err) {
        throw controller.signal.aborted ? controller.signal.reason : err;
      } finally {
        clearTimeout(timer);
        try {
          await cleanup(record);
        } catch (err) {
          // A journal write that failed, say. The slot must come back regardless.
          log(`Run ${record.runId} cleanup failed: ${err instanceof Error ? err.message : err}`);
        }
        clock.lap("cleanup");
        release();
        log(`run ${record.runId} timings: ${clock}${own ? ` (${own})` : ""}`);
      }
    })();

    inFlight.set(controller, task);
    try {
      return await task;
    } finally {
      inFlight.delete(controller);
    }
  }

  /** Cleans up runs a previous process left behind (see journal.ts). Call before taking work. */
  async function recover(): Promise<void> {
    const records = journal.list();
    if (records.length) log(`Cleaning up ${records.length} run(s) left by a previous process`);
    await Promise.all(records.map(cleanup));
  }

  /** Refuses new runs, aborts the ones in progress, and resolves once their cleanup finishes. */
  async function shutdown(): Promise<void> {
    shuttingDown = true;
    for (const controller of inFlight.keys()) controller.abort(new Error("run aborted: shutting down"));
    await Promise.allSettled(inFlight.values());
  }

  return { run, recover, shutdown };
}

export type Runner = ReturnType<typeof createRunner>;
