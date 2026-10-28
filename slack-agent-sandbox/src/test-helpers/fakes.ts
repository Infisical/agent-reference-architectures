import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "../harness.js";
import type { SlackApi, SlackMessage } from "../handler.js";
import type { ExecEvent, RunCallbacks, RunOptions, SandboxApi, SessionApi } from "../run.js";
import type { SessionStatus } from "../vault.js";

/** Records Slack calls; `history` is what conversations.replies returns. */
export class FakeSlack implements SlackApi {
  posts: { channel: string; thread_ts: string; text: string }[] = [];
  updates: { channel: string; ts: string; text: string }[] = [];
  repliesCalls: { channel: string; ts: string; cursor?: string }[] = [];
  deletes: { channel: string; ts: string }[] = [];
  history: SlackMessage[] = [];
  /** conversations.replies page size; unset returns the whole history in one page. */
  pageSize?: number;
  /** Message ts values whose deletion fails. */
  failDeletes = new Set<string>();
  private nextTs = 0;

  async postMessage(args: { channel: string; thread_ts: string; text: string }) {
    this.posts.push(args);
    return { ts: `ts-${++this.nextTs}` };
  }

  async update(args: { channel: string; ts: string; text: string }) {
    this.updates.push(args);
    return {};
  }

  async replies(args: { channel: string; ts: string; cursor?: string }) {
    this.repliesCalls.push(args);
    if (!this.pageSize) return { messages: this.history };
    const start = Number(args.cursor ?? 0);
    const end = start + this.pageSize;
    return {
      messages: this.history.slice(start, end),
      response_metadata: { next_cursor: end < this.history.length ? String(end) : "" },
    };
  }

  async delete(args: { channel: string; ts: string }) {
    if (this.failDeletes.has(args.ts)) throw new Error("cant_delete_message");
    this.deletes.push(args);
    return {};
  }
}

/**
 * A runner whose output is scripted per call, standing in for run.ts in handler tests. The
 * script may emit events through `callbacks`, wait, throw, or return the final answer.
 */
export class FakeRunner {
  calls: string[] = [];
  /** The access bundles each call asked for. */
  bundles: string[][] = [];

  constructor(private script: (prompt: string, options: RunOptions, callIndex: number) => Promise<string> | string) {}

  async run(prompt: string, options: RunOptions): Promise<string> {
    const index = this.calls.push(prompt) - 1;
    this.bundles.push(options.accessBundles);
    return this.script(prompt, options, index);
  }
}

/** Emits each event through the callbacks, letting the handler react between them. */
export async function emit(callbacks: RunCallbacks, events: HarnessEvent[]) {
  for (const event of events) {
    callbacks.onEvent?.(event);
    await flush();
  }
}

/**
 * In-memory SPACE. `output` scripts each exec's events; it may be an async generator to pace
 * them or fail partway. Every call is recorded, in order, in `log`, so tests can check what
 * reached SPACE (and that no token did).
 */
export class FakeSandboxes implements SandboxApi {
  log: string[] = [];
  live = new Set<string>();
  execs: { sandboxId: string; command: string; stdin: string }[] = [];
  failCreate?: Error;
  /** Fails create after the sandbox was accepted, as a VM that never boots would. */
  failBoot?: Error;
  /** How many delete calls fail before one succeeds. */
  failDeletes = 0;
  private next = 0;

  constructor(public output: (stdin: string, signal: AbortSignal) => AsyncIterable<ExecEvent> | ExecEvent[] = () => []) {}

  async create(template: string, signal: AbortSignal, onAccepted: (sandboxId: string) => void) {
    signal.throwIfAborted();
    this.log.push(`create ${template}`);
    if (this.failCreate) throw this.failCreate;
    const id = `sb-${++this.next}`;
    this.live.add(id);
    onAccepted(id);
    if (this.failBoot) throw this.failBoot;
    return { id };
  }

  async *exec(sandboxId: string, { command, stdin, signal }: { command: string; stdin: string; signal: AbortSignal }) {
    this.log.push(`exec ${sandboxId}`);
    this.execs.push({ sandboxId, command, stdin });
    yield* await this.output(stdin, signal);
  }

  async delete(sandboxId: string) {
    this.log.push(`delete ${sandboxId}`);
    if (this.failDeletes > 0) {
      this.failDeletes--;
      throw new Error("delete failed");
    }
    this.live.delete(sandboxId);
  }
}

/**
 * In-memory Agent Vault sessions; tokens look like real ones so leaks are easy to grep for.
 * Like Infisical, it refuses a bundle outside `grants` (when set) with a 400.
 */
export class FakeSessions implements SessionApi {
  log: string[] = [];
  active = new Set<string>();
  /** Every create request, in order. */
  requests: { accessBundles: string[]; ttl: string }[] = [];
  grants?: string[];
  /** How many revoke calls fail before one succeeds. */
  failRevokes = 0;
  private sessions = new Map<string, SessionStatus>();
  private next = 0;

  async create(request: { accessBundles: string[]; ttl: string }) {
    this.requests.push(request);
    const refused = request.accessBundles.find((b) => this.grants && !this.grants.includes(b));
    if (refused) {
      throw new Error(`Infisical POST /api/v1/agent-vault/sessions failed: HTTP 400 No access bundle named '${refused}' is granted to you.`);
    }
    const id = `sess-${++this.next}`;
    this.log.push(`create ${id}`);
    this.active.add(id);
    const accessBundles = request.accessBundles.map((name) => ({ name }));
    this.sessions.set(id, { id, status: "active", revokedAt: null, expiresAt: "later", accessBundles });
    return { id, token: `agv_secret-${this.next}` };
  }

  async revoke(sessionId: string) {
    this.log.push(`revoke ${sessionId}`);
    if (this.failRevokes > 0) {
      this.failRevokes--;
      throw new Error("revoke failed");
    }
    this.active.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (session && !session.revokedAt) Object.assign(session, { status: "revoked", revokedAt: "now" });
  }

  /** What GET /sessions/:id would report. */
  async getSession(sessionId: string): Promise<SessionStatus> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`HTTP 404 session ${sessionId} not found`);
    return { ...session };
  }
}

/** A Claude stream-json line for a Bash tool call described as "List files". */
export const claudeToolUse = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Bash", input: { description: "List files" } }] },
});

/** A Claude stream-json result line carrying the final answer. */
export const claudeResult = (text: string) => JSON.stringify({ type: "result", result: text });

/** Stdout events carrying these lines, then an exit. */
export function claudeOutput(lines: string[], code = 0): ExecEvent[] {
  return [...lines.map((line) => ({ type: "stdout" as const, data: `${line}\n` })), { type: "exit" as const, code }];
}

/** A stream that never produces anything until its signal aborts. */
export async function* hang(signal: AbortSignal): AsyncGenerator<ExecEvent> {
  await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Everything an async iterable yields, in order. */
export async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

const tempDirs: string[] = [];
process.once("exit", () => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A fresh temp directory, removed when the test process exits. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Lets pending promise callbacks and async generator steps run. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));
