import { test } from "node:test";
import assert from "node:assert/strict";
import { createVault } from "./vault.js";

interface Call {
  method: string;
  url: string;
  auth?: string;
  body?: unknown;
}

/** A fetch that records calls and answers from `routes`, keyed by "METHOD path". */
function fakeFetch(routes: Record<string, (call: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init.method ?? "GET",
      url,
      auth: headers.authorization,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${new URL(url).pathname}`];
    const { status = 200, body } = route ? route(call) : { status: 404, body: { message: "not found" } };
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, doFetch };
}

const LOGIN = "POST /api/v1/auth/universal-auth/login";
const CREATE = "POST /api/v1/agent-vault/sessions";
let logins = 0;
const login = () => ({ body: { accessToken: `at-${++logins}`, expiresIn: 3600, tokenType: "Bearer" } });

function vault(routes: Parameters<typeof fakeFetch>[0]) {
  const { calls, doFetch } = fakeFetch({ [LOGIN]: login, ...routes });
  const v = createVault({
    domain: "https://infisical.test/",
    clientId: "cid",
    clientSecret: "csecret",
    fetch: doFetch,
  });
  return { calls, ...v };
}

const request = (accessBundles = ["coding-agent"], ttl = "15m") => ({ accessBundles, ttl });

test("create: logs in once, then mints a session for the bundle with the ttl", async () => {
  const { calls, sessions } = vault({
    [CREATE]: () => ({ body: { session: { id: "s1", token: "agv_x", expiresAt: null, accessBundles: [] } } }),
  });
  assert.deepEqual(await sessions.create(request()), { id: "s1", token: "agv_x" });
  await sessions.create(request());

  assert.equal(calls.filter((c) => c.url.endsWith("/login")).length, 1, "access token is cached");
  assert.deepEqual(calls[0].body, { clientId: "cid", clientSecret: "csecret" });
  assert.equal(calls[1].url, "https://infisical.test/api/v1/agent-vault/sessions");
  assert.deepEqual(calls[1].body, { accessBundles: ["coding-agent"], ttl: "15m" });
  assert.match(calls[1].auth ?? "", /^Bearer at-\d+$/);
});

test("create: each session carries the bundles its caller chose, not one fixed on the client", async () => {
  const { calls, sessions } = vault({ [CREATE]: () => ({ body: { session: { id: "s", token: "t" } } }) });
  await sessions.create(request(["coding-agent"]));
  await sessions.create(request(["read-only"], "5m"));
  assert.deepEqual(
    calls.filter((c) => c.url.endsWith("/sessions")).map((c) => c.body),
    [request(["coding-agent"]), request(["read-only"], "5m")],
  );
});

test("create: a bundle the identity isn't granted is refused by Infisical, and no token comes back", async () => {
  const { sessions } = vault({
    [CREATE]: () => ({
      status: 400,
      body: { message: "No access bundle named 'admin' is granted to you. Check the name, or ask an Agent Vault admin to grant it." },
    }),
  });
  await assert.rejects(sessions.create(request(["admin"])), /HTTP 400 .*'admin' is granted to you/);
});

test("revoke: posts to the session's revoke route", async () => {
  const { calls, sessions } = vault({ "POST /api/v1/agent-vault/sessions/s1/revoke": () => ({ body: { session: {} } }) });
  await sessions.revoke("s1");
  assert.equal(calls.at(-1)?.url, "https://infisical.test/api/v1/agent-vault/sessions/s1/revoke");
});

test("getSession: returns the session's status", async () => {
  const session = {
    id: "s1",
    status: "revoked",
    revokedAt: "2026-10-18T00:00:00Z",
    expiresAt: null,
    accessBundles: [{ name: "coding-agent" }],
  };
  const { getSession } = vault({ "GET /api/v1/agent-vault/sessions/s1": () => ({ body: { session } }) });
  assert.deepEqual(await getSession("s1"), session);
});

test("a 401 logs in again once and retries", async () => {
  let attempts = 0;
  const { calls, sessions } = vault({
    [CREATE]: () =>
      ++attempts === 1 ? { status: 401, body: { message: "expired" } } : { body: { session: { id: "s2", token: "t" } } },
  });
  assert.equal((await sessions.create(request())).id, "s2");
  assert.equal(calls.filter((c) => c.url.endsWith("/login")).length, 2);
});

test("errors carry the status and body but never the credentials, and a failed login isn't cached", async () => {
  let fail = true;
  const { calls, sessions } = vault({
    [LOGIN]: () => (fail ? { status: 400, body: { message: "bad secret" } } : login()),
    [CREATE]: () => ({ status: 403, body: { message: "forbidden" } }),
  });
  const errors: string[] = [];
  const failure = (pattern: RegExp) => (err: Error) => (errors.push(err.message), pattern.test(err.message));
  await assert.rejects(sessions.create(request()), failure(/universal-auth\/login failed: HTTP 400 .*bad secret/));
  fail = false;
  await assert.rejects(sessions.create(request()), failure(/agent-vault\/sessions failed: HTTP 403 .*forbidden/));
  assert.equal(calls.filter((c) => c.url.endsWith("/login")).length, 2);
  assert.ok(errors.every((m) => !m.includes("csecret") && !/\bat-\d/.test(m)), "no client secret or access token");
});
