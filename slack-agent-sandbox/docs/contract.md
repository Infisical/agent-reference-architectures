# SPACE and Agent Vault API notes

The API shapes and behavior Atlas depends on. `src/space.ts` and `src/vault.ts` implement them. These were checked against a running SPACE deployment (OpenAPI v0.8.0) and Infisical; SPACE's own [API reference](https://space.docs.perplexity.ai/api/index.html) is the authority if they disagree.

## 1. SPACE API

Management calls go to `SPACE_API_URL` (8080) under `/v1`. They take `Authorization: Bearer <SPACE_API_TOKEN>`. Every mutation requires an `Idempotency-Key` header.

| Operation | Method and path | Port | Request | Response |
|---|---|---|---|---|
| Create sandbox | `POST /v1/sandboxes` | 8080 | `{"template":"coding-agent:v1","runtime":"firecracker","metadata":{...},"network_policy":{...}}` | `202 {operation_id, sandbox_id}` |
| Readiness | `GET /v1/operations/{operation_id}`, polled | 8080 | | `{id, kind, state, target_id, terminal_error_code, terminal_error: {message}, ...}`. `state` goes `running` to `succeeded`; failures end in `failed` |
| Exec with stdin | `POST /v1/sandboxes/{id}/commands`, then the WebSocket at `attach.url` | 8080, then 8090 | `{"command":["sh","-c",<script>],"stdin":true}` | `201 {session_id, process_id, sandbox_id, state:"pending", attach:{url, events_url, token, expires_at, token_transport}, ...}`; see 1.2 |
| Exec output stream (SSE) | `GET {attach.events_url}`, `Authorization: Bearer <attach.token>` | 8090 | | `text/event-stream`; see 1.1. Not used by `space.ts` |
| Delete sandbox | `DELETE /v1/sandboxes/{id}` | 8080 | | `202 {operation_id, sandbox_id}`; the operation succeeds in about 1 s |
| Get sandbox (smoke check) | `GET /v1/sandboxes/{id}` | 8080 | | `200 {id, state, conditions, template, metadata, idle_timeout, idle_action, ...}`; `404 not_found` once deleted |

Observed behavior:

- **Template tag is required.** `coding-agent:v1` resolves; a bare `coding-agent` fails at once with `not_found`.
- **Boot time is 1 to 3 s with the template cached on the node,** from accept to `succeeded`; commands work as soon as the operation succeeds. A node without the template first pulls and unpacks it, which takes about a minute. Have SPACE prefetch and pin the template on each node so its cache doesn't evict it between runs.
- **A failed create leaves nothing:** the sandbox ID it returned is 404 straight away.
- **Delete is safe to repeat:** the same `Idempotency-Key` returns the original operation, while a new key, or an ID that never existed, gets `404 not_found`. `space.ts` treats 404 as already deleted.
- **The default idle policy suspends, it doesn't delete,** so a leaked sandbox stays around. `space.ts` tags every sandbox with `metadata: {app: "atlas"}` so leaks can be found.
- **Error envelope:** `{code, message, request_id, retryable, details}`.
- **Timeout exit:** a command `timeout` that expires ends the process with `process_exited {exit_code: 124, status: "timed_out"}`.

### 1.1 Frames

SSE and the WebSocket carry the same JSON frames. Over SSE, each event is `event: <type>`, `data: <frame>`, then `id: <n>` (numbered from `process_started`). Over the WebSocket each message is one frame, with no ids. A full run (recorded in `src/__fixtures__/space-exec.jsonl`):

```
{"type":"attached","session_id":"proc_...","route_generation":2,"current_node_id":"..."}
{"type":"process_started","process_id":"proc_...","pid":304}
{"type":"input_accepted","seq":0}
{"type":"stdout","seq":1,"data_base64":"Zmlyc3QgbGluZSByZWFkCg=="}
{"type":"control_accepted","seq":1}
{"type":"stdout","seq":2,"data_base64":"aGVsbG8gZnJvbSBzdGRpbgo="}
{"type":"stderr","seq":3,"data_base64":"d2FybmluZwo="}
{"type":"stdout","seq":4,"data_base64":"Y2Fmw6kK"}
{"type":"process_exited","process_id":"proc_...","exit_code":0,"status":"exited"}
{"type":"closed","reason":"backend_closed"}
```

`data_base64` is standard base64. Nonzero exit codes come through as is. The server closes the socket after `closed` (WebSocket close code 1005).

### 1.2 Stdin over the WebSocket

1. Connect to `attach.url`, resolved against `SPACE_DATA_PLANE_URL` with `ws:`/`wss:`. The URL is relative: `/v1/sessions/<session_id>/attach`.
2. Send `{"type":"attach","token":<attach.token>}` as the first frame. `token_transport` also lists `sec_websocket_protocol` and `authorization_header`. The attach token expires 5 minutes after the command is created.
3. The server sends `attached`, then `process_started`. Attaching starts the process.
4. **Only after `process_started`**, send `{"type":"input","seq":0,"data_base64":...}`, then `{"type":"close_stdin","seq":1}`. Input sent earlier can fail with `{"type":"error","code":"process_not_started"}`. `seq` starts at 0 and is shared by input and control frames. The server acknowledges with `input_accepted` and `control_accepted`.

Observed:

- **Bytes arrive exactly as sent:** the first line, multi-line text with quotes, `&` and `$`, and UTF-8.
- **300 KB in one `input` frame** arrived intact. `space.ts` sends one frame per command.
- **Silent runs:** the connection survived 200 s with no output and no heartbeat frames.
- **Abort:** closing the socket made the stream reject within milliseconds in `space.ts`, and the sandbox was then deleted.
- **Stdin stays out of SPACE's records.** With a canary on stdin, `GET /processes`, `GET /processes/{id}`, `GET /sandboxes/{id}/sessions` and `GET /sessions/{id}` held no copy of it. Those endpoints **do** return the full argv, which is why the token must not go in the command.

## 2. Ports, auth and returned URLs

- **Ports:** 8080 serves management calls; 8090 serves the data plane (`/v1/sessions/{id}/events` and `/v1/sessions/{id}/attach`). The data plane takes only the per-command `attach.token`.
- **Client auth:** `Authorization: Bearer <SPACE_API_TOKEN>`. Rotate the token before it expires.
- **Login:** commands run as a non-root user in `/home/user`. `/home/user/workspace` already exists and belongs to that user.
- **Returned URLs:** `attach.url` and `attach.events_url` are relative paths. `space.ts` resolves them against `SPACE_DATA_PLANE_URL` and refuses any that point elsewhere, so the token is never sent to another host.

## 3. Agent Vault sessions

`src/vault.ts` implements this, and `npm run smoke -- --preflight` exercises it:

- `POST /api/v1/auth/universal-auth/login` `{clientId, clientSecret}` returns `{accessToken, expiresIn, ...}`.
- `POST /api/v1/agent-vault/sessions` `{accessBundles: ["<slug>"], ttl: "15m"}` returns `{session: {id, token, expiresAt, createdAt, accessBundles: [{id, name, position}]}}`. The token starts `agv_` and is returned only here.
- `GET /api/v1/agent-vault/sessions/:id` returns `{session: {id, status, expiresAt, revokedAt, createdAt, actor, accessBundles}}`. `status` is `active`, `revoked` or `expired`.
- `POST /api/v1/agent-vault/sessions/:id/revoke` returns 200 `{session}`, and again 200 for a session already revoked.

Rules the server enforces:

- **One access bundle per session**; more is a 400. The API and `SessionApi.create` still take an array.
- **Only granted access bundles.** One the identity isn't granted, or one that doesn't exist, is a 400: `No access bundle named '<x>' is granted to you`.
- **Admins bypass grants.** An Agent Vault Admin can mint over any access bundle, so the identity must be a plain Member. The preflight flags an identity that can mint an ungranted bundle.
- **TTL** is a duration of at least `1m`, or `never`. It defaults to `7d`, so Atlas always sends one: the run timeout plus 5 minutes.
- A non-admin identity sees and revokes only its own sessions; anything else is a 404.

The orchestrator chooses the access bundles for each run (`runner.run(prompt, {accessBundles})`). In this version it always passes `AGENT_VAULT_ACCESS_BUNDLE`. Nothing about the access bundle reaches the VM: no bundle variable, no identity credentials, and no route to Infisical.

## 4. Running the agent in the VM

The bootstrap script (`bootstrapScript()` in `src/run.ts`) relies on:

- **Infisical CLI 0.44.2 or later** in the template.
- `INFISICAL_AGENT_VAULT_SESSION_TOKEN` and `INFISICAL_AGENT_VAULT_PROXY_ADDRESS`. With a token, `agent-vault run` makes no Infisical API call: it fetches the proxy CA from `http://<proxy>/_agent-vault/ca`, then starts the agent with `HTTP(S)_PROXY=http://x-agent-vault:<token>@<proxy>`, `NODE_USE_ENV_PROXY=1` and `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE` pointing at the CA.
- **A workaround for CLI startup delay.** In CLI 0.44.2, `--telemetry=false` is read after the telemetry client is built, and the CLI also checks GitHub for updates. With no DNS in the VM, both waited out a 10 s timeout before every agent started. `bootstrapScript` points the CLI's own `HTTP(S)_PROXY` at a closed local port (`CLI_OFFLINE_ENV`), so both calls fail at once. `agent-vault run` replaces those variables for the agent, and fetches the CA without a proxy. Remove the workaround once the template ships a CLI that honours the flag.
- **`read -r`** consumes the first stdin line (the token); the rest reaches the agent unchanged.
- **Claude Code prints `stream-json` and exits 0.** The template's Claude Code is not logged in, so the harness sets a placeholder `ANTHROPIC_API_KEY`; the proxy overwrites `x-api-key` with the real key. Non-essential traffic and the auto-updater are off.
- **Node 24 or later** in the VM, for `NODE_USE_ENV_PROXY`.
- **Proxy CA pin.** `--ca-fingerprint` is the SHA-256 of the CA certificate's DER as `SHA256:AA:BB:...`; the CLI compares it ignoring case, colons and the prefix. Take it from Infisical's record of the enrolled proxy (the Agent Vault **Proxies** page), never from what the address serves. With a wrong pin, the run fails inside the VM before the agent starts. If the proxy is re-enrolled, pin the new fingerprint or every run fails.

## 5. Network layers

A sandbox should reach the proxy and nothing else. In a SPACE deployment on Kubernetes, three layers decide that, and all of them must allow the proxy:

1. **Node guardrail**: SPACE drops guest traffic to private (RFC 1918) addresses by default. Add an operator exception for exactly the proxy's IP and port (TCP `17323`).
2. **SPACE per-sandbox egress policy**, derived in `loadConfig` from `AGENT_VAULT_PROXY_ADDRESS` (`proxyOnlyEgressPolicy`) and sent by `space.ts` on create: `{"version":"v1","egress":{"default_action":"deny","allow":[{"ip":"<proxy IP>"}],"deny":[]}}`. It replaces the template default, which denies all egress. SPACE rules have no port, so this admits the host on every port. `network_policy` is marked incubating in SPACE's OpenAPI spec.
3. **Kubernetes NetworkPolicy** in the sandboxes namespace that lets sandbox pods reach only the proxy's IP on TCP `17323`. Applied once, so the orchestrator needs no Kubernetes credentials.

Layer 3 adds no reach beyond layer 1; layer 2 decides which sandboxes get through. What the preflight checks from inside a VM, and what a correct setup shows:

| Check | Expected |
|---|---|
| Template default only (no layer 2), CA fetch from the proxy | **blocked** |
| `GET /v1/models` through the proxy with the placeholder key | **200** (free call; the key is attached) |
| SSH (`:22`) on the proxy host | **blocked** (no banner) |
| Direct TLS handshake to Anthropic's API address | **blocked** |
| DNS for `api.anthropic.com` and `app.infisical.com` | doesn't resolve |
| Credential variables in the agent's environment (identity, access bundle, OAuth) | none |

SPACE's gateway accepts every guest TCP connection before deciding, so a bare TCP connect "succeeds" even to blocked hosts. Checks must look for a TLS handshake or a banner.

## 6. Fixture

`src/__fixtures__/space-exec.jsonl` is a WebSocket session's frames with harmless input and IDs replaced.
