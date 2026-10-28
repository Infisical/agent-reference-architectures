import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { HttpError } from "./http.js";
import { createSpace, proxyOnlyEgressPolicy, type EgressPolicy } from "./space.js";
import { collect } from "./test-helpers/fakes.js";

const TOKEN = "dp-token";
const never = new AbortController().signal;

/** Frames recorded from a live SPACE session; see docs/contract.md. */
const recorded = readFileSync(new URL("./__fixtures__/space-exec.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

type Reply = { status: number; body?: unknown };
interface ApiRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: any;
}

/**
 * A stand-in for SPACE: `api` answers management calls, `session` drives each WebSocket after a
 * valid attach frame. By default a session replays the recorded frames, sending output only once
 * the client has closed stdin, as a process reading stdin to EOF would.
 */
function setup(
  t: TestContext,
  {
    api = () => ({ status: 404 }),
    session = replay(recorded),
    attachUrl,
    networkPolicy,
  }: {
    api?: (req: ApiRequest) => Reply;
    session?: (ws: WebSocket, received: any[]) => void;
    attachUrl?: string;
    networkPolicy?: EgressPolicy;
  } = {},
) {
  const requests: ApiRequest[] = [];
  const received: any[] = [];
  let sockets = 0;

  const http = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request: ApiRequest = { method: req.method!, path: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    requests.push(request);
    const isCommand = req.method === "POST" && req.url!.endsWith("/commands");
    const reply = isCommand
      ? { status: 201, body: { attach: { url: attachUrl ?? "/v1/sessions/proc_1/attach", token: TOKEN } } }
      : api(request);
    res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body ?? {}));
  });
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => {
    sockets++;
    ws.once("message", (data) => {
      const attach = JSON.parse(String(data));
      if (attach.type !== "attach" || attach.token !== TOKEN) return ws.close();
      ws.on("message", (frame) => received.push(JSON.parse(String(frame))));
      session(ws, received);
    });
  });
  http.listen(0);
  t.after(() => {
    http.close();
    wss.close();
    for (const ws of wss.clients) ws.terminate();
  });

  const space = createSpace({
    apiUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    dataPlaneUrl: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    apiToken: "api-token",
    pollIntervalMs: 1,
    networkPolicy,
  });
  return { space, requests, received, sockets: () => sockets };
}

const send = (ws: WebSocket, frame: unknown) => ws.send(JSON.stringify(frame));
const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64");

/** Sends frames up to process_started, then the rest once the client closes stdin. */
function replay(frames: any[]) {
  const started = frames.findIndex((f) => f.type === "process_started") + 1;
  return (ws: WebSocket) => {
    frames.slice(0, started).forEach((f) => send(ws, f));
    ws.on("message", (data) => {
      if (JSON.parse(String(data)).type !== "close_stdin") return;
      frames.slice(started).forEach((f) => send(ws, f));
      ws.close();
    });
  };
}

const started = [{ type: "attached" }, { type: "process_started", pid: 1 }];
const output = (type: "stdout" | "stderr", data: string | Buffer) => ({ type, data_base64: b64(data) });
const exited = (code: number) => ({ type: "process_exited", exit_code: code, status: "exited" });

/** An operation that reports each of `states` on successive polls, then stays on the last. */
const operations = (states: string[]) => {
  let polls = 0;
  return () => ({ kind: "create_sandbox", state: states[Math.min(polls++, states.length - 1)], terminal_error_code: null, terminal_error: null });
};

test("create: accepts the sandbox, reports its ID, then waits for the operation to succeed", async (t) => {
  const accepted: string[] = [];
  const op = operations(["running", "running", "succeeded"]);
  const { space, requests } = setup(t, {
    api: (req) => {
      if (req.method === "POST") return { status: 202, body: { operation_id: "op_1", sandbox_id: "sbx_1" } };
      assert.deepEqual(accepted, ["sbx_1"], "the ID is reported before the sandbox is ready");
      return { status: 200, body: op() };
    },
  });

  assert.deepEqual(await space.create("coding-agent:v1", never, (id) => accepted.push(id)), { id: "sbx_1" });
  const [create, ...polls] = requests;
  assert.equal(create.path, "/v1/sandboxes");
  assert.deepEqual(create.body, { template: "coding-agent:v1", runtime: "firecracker", metadata: { app: "atlas" } });
  assert.equal(create.headers.authorization, "Bearer api-token");
  assert.ok(create.headers["idempotency-key"]);
  assert.deepEqual(
    polls.map((r) => r.path),
    ["/v1/operations/op_1", "/v1/operations/op_1", "/v1/operations/op_1"],
  );
  assert.ok(polls.every((r) => !r.headers["idempotency-key"]));
});

test("create: sends the configured egress policy, which lets the VM reach only the proxy host", async (t) => {
  const policy = proxyOnlyEgressPolicy("10.0.0.5:17323");
  assert.deepEqual(policy, {
    version: "v1",
    egress: { default_action: "deny", allow: [{ ip: "10.0.0.5" }], deny: [] },
  });
  assert.deepEqual(proxyOnlyEgressPolicy("proxy.internal:17323").egress.allow, [{ domain: "proxy.internal" }]);
  assert.deepEqual(proxyOnlyEgressPolicy("[fd00::1]:17323").egress.allow, [{ ip: "fd00::1" }]);

  const { space, requests } = setup(t, {
    networkPolicy: policy,
    api: (req) =>
      req.method === "POST"
        ? { status: 202, body: { operation_id: "op_1", sandbox_id: "sbx_1" } }
        : { status: 200, body: operations(["succeeded"])() },
  });
  await space.create("coding-agent:v1", never, () => {});
  assert.deepEqual(requests[0].body.network_policy, policy);
});

test("create: a failed operation rejects with SPACE's reason, after the ID was reported", async (t) => {
  const accepted: string[] = [];
  const { space } = setup(t, {
    api: (req) =>
      req.method === "POST"
        ? { status: 202, body: { operation_id: "op_1", sandbox_id: "sbx_1" } }
        : {
            status: 200,
            body: {
              kind: "create_sandbox",
              state: "failed",
              terminal_error_code: "not_found",
              terminal_error: { message: "no release found for template 'coding-agent' runtime 'fc' tag 'latest'" },
            },
          },
  });
  await assert.rejects(
    space.create("coding-agent", never, (id) => accepted.push(id)),
    /SPACE create_sandbox failed: not_found: no release found/,
  );
  assert.deepEqual(accepted, ["sbx_1"]);
});

test("management errors carry SPACE's error envelope", async (t) => {
  const { space } = setup(t, {
    api: () => ({
      status: 503,
      body: { code: "capacity_unavailable", message: "no capacity", request_id: "req_9", retryable: true, details: [] },
    }),
  });
  const err = await space.create("coding-agent:v1", never, () => {}).catch((e) => e);
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 503);
  assert.equal(err.code, "capacity_unavailable");
  assert.match(err.message, /HTTP 503 capacity_unavailable: no capacity \(request req_9\)/);
});

test("exec: sends the token on stdin over the WebSocket and streams the recorded output", async (t) => {
  const { space, requests, received } = setup(t);
  const events = await collect(
    space.exec("sbx_1", { command: "IFS= read -r T; cat", stdin: "fixture-token\nhello from stdin\n", signal: never }),
  );

  const [command] = requests;
  assert.equal(command.path, "/v1/sandboxes/sbx_1/commands");
  assert.deepEqual(command.body, { command: ["sh", "-c", "IFS= read -r T; cat"], stdin: true });
  assert.ok(!JSON.stringify(command).includes("fixture-token"), "the stdin never reaches the management API");
  assert.deepEqual(received, [
    { type: "input", seq: 0, data_base64: b64("fixture-token\nhello from stdin\n") },
    { type: "close_stdin", seq: 1 },
  ]);
  assert.deepEqual(events, [
    { type: "stdout", data: "first line read\n" },
    { type: "stdout", data: "hello from stdin\n" },
    { type: "stderr", data: "warning\n" },
    { type: "stdout", data: "café\n" },
    { type: "exit", code: 0 },
  ]);
});

test("exec: waits for process_started before sending stdin, which SPACE refuses earlier", async (t) => {
  const { space, received } = setup(t, {
    session: async (ws, received) => {
      send(ws, { type: "attached" });
      await sleep(20);
      assert.deepEqual(received, [], "nothing sent before the process started");
      send(ws, { type: "process_started", pid: 1 });
      await sleep(20);
      send(ws, exited(0));
      ws.close();
    },
  });
  await collect(space.exec("sbx_1", { command: "cat", stdin: "x", signal: never }));
  assert.deepEqual(
    received.map((f) => f.type),
    ["input", "close_stdin"],
  );
});

test("exec: decodes a UTF-8 character split across output frames", async (t) => {
  const rocket = Buffer.from("🚀\n");
  const { space } = setup(t, {
    session: replay([...started, output("stdout", rocket.subarray(0, 2)), output("stdout", rocket.subarray(2)), exited(0)]),
  });
  const events = await collect(space.exec("sbx_1", { command: "x", stdin: "", signal: never }));
  assert.deepEqual(events, [
    { type: "stdout", data: "🚀\n" },
    { type: "exit", code: 0 },
  ]);
});

test("exec: a nonzero or timed-out exit is reported as an exit event", async (t) => {
  const { space } = setup(t, {
    session: replay([...started, { type: "process_exited", exit_code: 124, status: "timed_out" }, { type: "closed", reason: "backend_closed" }]),
  });
  const events = await collect(space.exec("sbx_1", { command: "x", stdin: "", signal: never }));
  assert.deepEqual(events, [{ type: "exit", code: 124 }]);
});

test("exec: an error frame, or a close before the exit, rejects", async (t) => {
  const failing = setup(t, {
    session: replay([...started, { type: "error", code: "backend_stream_error", message: "lost", retryable: false }]),
  });
  await assert.rejects(
    collect(failing.space.exec("sbx_1", { command: "x", stdin: "", signal: never })),
    /SPACE stream error backend_stream_error: lost/,
  );

  const closing = setup(t, { session: replay([...started, { type: "closed", reason: "revoked" }]) });
  await assert.rejects(
    collect(closing.space.exec("sbx_1", { command: "x", stdin: "", signal: never })),
    /closed before the command exited: revoked/,
  );
});

test("exec: refuses an attach URL off the data plane, so the token isn't sent there", async (t) => {
  const { space, sockets } = setup(t, { attachUrl: "ws://evil.example/v1/sessions/proc_1/attach" });
  await assert.rejects(
    collect(space.exec("sbx_1", { command: "x", stdin: "", signal: never })),
    /attach URL ws:\/\/evil.example is not the data plane/,
  );
  assert.equal(sockets(), 0);
});

test("exec: aborting closes the socket and rejects with the abort reason", async (t) => {
  const controller = new AbortController();
  let closed: Promise<unknown> | undefined;
  const { space } = setup(t, {
    session: (ws) => {
      closed = once(ws, "close");
      started.forEach((f) => send(ws, f));
      controller.abort(new Error("run timed out"));
    },
  });
  await assert.rejects(collect(space.exec("sbx_1", { command: "sleep 60", stdin: "", signal: controller.signal })), /run timed out/);
  await closed;
});

test("delete: waits for the operation, and treats a sandbox that's already gone as deleted", async (t) => {
  const op = operations(["running", "succeeded"]);
  const { space, requests } = setup(t, {
    api: (req) =>
      req.method === "DELETE"
        ? { status: 202, body: { operation_id: "op_d", sandbox_id: "sbx_1" } }
        : { status: 200, body: op() },
  });
  await space.delete("sbx_1");
  assert.equal(requests[0].method, "DELETE");
  assert.equal(requests[0].path, "/v1/sandboxes/sbx_1");
  assert.ok(requests[0].headers["idempotency-key"]);

  const gone = setup(t, {
    api: () => ({ status: 404, body: { code: "not_found", message: "sandbox not found", request_id: null, retryable: false, details: [] } }),
  });
  await gone.space.delete("sbx_1");

  const broken = setup(t, { api: () => ({ status: 500, body: { code: "internal", message: "boom", request_id: "req_1" } }) });
  await assert.rejects(broken.space.delete("sbx_1"), /HTTP 500 internal: boom/);
});
