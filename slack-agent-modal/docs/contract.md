# Modal and Agent Vault API notes

The API shapes and behavior Apollo depends on. `src/modal.ts` implements them from the `modal` JS SDK (v0.11.0) and Modal's docs. Items marked **live** were checked against a real Modal workspace; items marked **docs** come from the SDK typings and Modal's docs and haven't been exercised on their own yet. Modal's [Sandbox guide](https://modal.com/docs/guide/sandboxes) is the authority if they disagree.

## 1. Modal Sandbox API

`src/modal.ts` uses the official `modal` npm package (`ModalClient`, authenticated with `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`).

| Operation | SDK call | Used for | Verified |
|---|---|---|---|
| App | `modal.apps.fromName(MODAL_APP_NAME, {createIfMissing: true})` | Every sandbox lives in this App | docs |
| Image | `images.fromRegistry("node:24-bookworm-slim").dockerfileCommands([...]).build(app)`; or `images.fromId` / `images.fromName` | `MODAL_IMAGE` (`src/image.ts`); built once at startup | docs |
| Create | `sandboxes.create(app, image, {timeoutMs, idleTimeoutMs, cpu, memoryMiB, tags, outboundCidrAllowlist})` | One sandbox per run; resolves once running | live (section 5) |
| Proxy sidecar | `volumes.fromName(AGENT_VAULT_PROXY_VOLUME).withMountOptions({readOnly: true})`; `sandbox.experimentalSidecars.create("agent-proxy", image, {command, volumes})`, then `exec` of a readiness check in it | Agent Proxy in every sandbox | live (section 5) |
| Exec with stdin | `sandbox.exec(["runuser","-u","user","--","sh","-c",script], {mode:"text", stdout:"pipe", stderr:"pipe"})`, then `stdin.writeText(token + "\n" + prompt)` and `stdin.close()` | The bootstrap script, which `cd`s to the workspace itself | docs |
| Output | `proc.stdout` / `proc.stderr` (`ReadableStream<string>`), `proc.wait()` for the exit code | Streaming stream-json to Slack | docs |
| Terminate | `sandboxes.fromId(id)` then `terminate({wait: true})`; `NotFoundError` counts as gone | Cleanup and recovery; without `wait`, `poll()` straight after still reports it running | live (preflight) |
| Exists | `sandboxes.fromId(id)` then `poll()`: `null` while running | Smoke test cleanup check | docs |
| Sweep | `sandboxes.list({appId, tags})` then `terminate()` each | `runner.recover()` after the journal cleanup: sandboxes the journal never saw, per role (`bot` or `smoke`) | docs |

Not yet verified:

- **Create time**: cold (first build or uncached image) and warm. SPACE booted in 1 to 3 s with the template cached.
- **No accepted state**: create resolves only once the sandbox runs and can't be cancelled, so the ID is journaled after boot. A crash during create leaves a sandbox the journal never saw; the next start's sweep (by role tag) and the sandbox `timeoutMs` (run timeout plus 5 minutes) cover it.
- **`fromId` on a terminated sandbox**: whether it throws `NotFoundError` or returns a handle whose `poll()` gives an exit code. `exists` and `delete` handle both.
- **`terminate` twice** is harmless.
- **Idle timeout** (5 minutes) doesn't fire during a long silent agent turn while an exec is running.
- **Tags** are listed and filtered by `sandboxes.list({appId, tags})`.

## 2. Auth, user and what Modal records

- **Auth**: `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` for a workspace token. Use a service user's token for deployments, not a person's.
- **User**: Modal runs commands as root. Claude Code refuses `--permission-mode bypassPermissions` as root, and SPACE ran agents as `uid=2000(user)`, so `modal.ts` wraps the bootstrap in `runuser -u user --`. `runuser` keeps the environment and sets `HOME=/home/user`. The preflight probe fails if the agent's uid is 0.
- **Argv is visible**: Modal's dashboard and logs show a command's argv. The token goes only on stdin (first line), and the prompt after it, as with SPACE. Confirm a canary on stdin appears nowhere in the dashboard or `sandbox.logs`.
- **Stdin**: 300 KB in one `writeText` arrives intact (SPACE was tested at that size); multi-line text with quotes, `&`, `$` and UTF-8 arrives byte for byte.

## 3. Agent Vault sessions

`src/vault.ts` implements this. Shapes are from the Infisical backend (`ee/routes/v1/agent-vault-routers/agent-vault-session-router.ts`, `ee/services/agent-vault-session/agent-vault-session-service.ts`) and were exercised live by the preflight (`npm run smoke -- --preflight --ungranted-bundle <slug>`). They are independent of the sandbox backend:

- `POST /api/v1/auth/universal-auth/login` `{clientId, clientSecret}` returns `{accessToken, expiresIn, ...}`.
- `POST /api/v1/agent-vault/sessions` `{accessBundles: ["<slug>"], ttl: "15m"}` returns `{session: {id, token, expiresAt, createdAt, accessBundles: [{id, name, position}]}}`. The token starts `agv_` and is returned only here.
- `GET /api/v1/agent-vault/sessions/:id` returns `{session: {id, status, expiresAt, revokedAt, createdAt, actor, accessBundles}}`. `status` is `active`, `revoked` or `expired`.
- `POST /api/v1/agent-vault/sessions/:id/revoke` returns 200 `{session}`, and again 200 for a session already revoked.
- The proxy rejects a revoked token after its poll interval (lag not measured).

Rules the server enforces:

- **One bundle per session** (`AGENT_VAULT_MAX_SESSION_BUNDLES = 1`); more is a 400. The API and `SessionApi.create` still take an array.
- **Only granted bundles.** A bundle the identity isn't granted, or one that doesn't exist, is a 400: `No access bundle named '<x>' is granted to you`. Verified live with an ungranted name.
- **Admins bypass grants.** An Agent Vault admin can mint over any bundle, so the identity must be a plain member. The preflight flags an identity that can mint the ungranted bundle.
- **TTL** is a duration of at least `1m`, or `never`. It defaults to `7d`, so Apollo always sends one: the run timeout plus 5 minutes.
- A non-admin identity sees and revokes only its own sessions; anything else is a 404.

The orchestrator chooses the bundles for each run (`runner.run(prompt, {accessBundles})`). In this version it always passes `AGENT_VAULT_ACCESS_BUNDLE`. Nothing about the bundle reaches the sandbox: no bundle variable and no identity credentials.

## 4. Stdin execution in the sandbox

The bootstrap script (`bootstrapScript` in `src/run.ts`) is the same as in [Atlas](../../slack-agent-sandbox). Not yet re-verified on Modal:

- The image's Infisical CLI is **0.44.2** and Claude Code **2.1.292**, the versions verified with SPACE (`src/image.ts`).
- `infisical agent-vault run` fetches the proxy CA from `http://<proxy>/_agent-vault/ca` and sets `HTTP(S)_PROXY`, `NODE_USE_ENV_PROXY=1` and `NODE_EXTRA_CA_CERTS` for the agent.
- **`CLI_OFFLINE_ENV` still needed?** In SPACE, CLI 0.44.2's PostHog client and update check each waited out a 10 s timeout because the VM had no DNS. Modal sandboxes resolve DNS, but the CIDR allowlist still drops the connection, so the hang is expected to remain. Measure agent startup with and without it.
- The rest of stdin reaches the command after `read -r` takes the first line.
- Claude Code prints stream-json and exits 0 with the placeholder `ANTHROPIC_API_KEY`, the real key injected by Agent Proxy.
- **Proxy CA pin**: a preflight with a wrong `AGENT_VAULT_CA_FINGERPRINT` fails inside the sandbox before the agent starts.

## 5. Network

Every sandbox runs its own Agent Proxy as a Modal sidecar (`sandbox.experimentalSidecars`, beta), named `agent-proxy`. The sidecar uses the sandbox's own image, which already has the Infisical CLI, and mounts the Modal Volume `agent-proxy-state` read-only at `/data`. It copies the enrollment to `/tmp/proxy` and starts `infisical agent-vault proxy` there, so no sandbox ever writes to the shared Volume. The enrollment is written once by [proxy/agent_proxy.py](../proxy/agent_proxy.py) (`modal run`). The agent's container is created with `outboundCidrAllowlist: []` and dials `agent-proxy:17323`, a name Modal resolves through the sandbox's `/etc/hosts`. `create` waits until the proxy serves its CA before the bootstrap runs (`startProxy` in `src/modal.ts`).

Verified live with Modal JS SDK 0.11.0:

- **Reachability** (live): 12 of 12 sandboxes, created with no region pin, reached their own sidecar proxy, in 0.7 to 1.3 s after the sidecar was created (4 s at worst). `GET /v1/models` through it with the placeholder key answered **200** in all 12. The preflight passes through `createModal` itself; "session and boot", sidecar included, takes about 1.4 s.
- **One enrollment, many copies** (live): 8 sidecars ran at once from the same Volume, alongside the earlier always-on proxy, with no conflicts. All report the same `proxyId` and CA fingerprint. The proxy's access token is a JWT with `iat` and `tokenVersion` but no `exp`: a copy stays valid until Infisical revokes it.
- **Revocation lag** (live): a revoked session stopped working through a sidecar proxy after 26.7 s, within the proxy's 30 s poll interval (`config.pollInterval` in `proxy.json`).
- **Isolation from the agent's container** (live, checked as root, which is more than the agent's uid 2000):

| Check from the agent's container | Result |
|---|---|
| `/data`, `/tmp/proxy`, a marker file the sidecar wrote to its `/tmp` | not found (the sidecar sees all three) |
| `find /` across all mounts for `proxy.json` / `ca.key` | nothing |
| `/proc/mounts` | no Volume mount |
| Processes | only its own; the proxy's isn't visible |
| A Modal Secret and an `env` value given to the sidecar | in neither its environment, any `/proc/*/environ`, nor its filesystem |
| Modal credentials in its environment | none |
| Sidecar ports | 17323 open; 22, 80, 8080 refused |
| Modal's API (`api.modal.com:443`), any public address | blocked |
| Kernel | its own gVisor instance: a different `boot_id` and boot log from the sidecar's |

  The agent can reach the sidecar only through the proxy's port, and can't create or change sidecars (Modal allows that only through its API, from outside the sandbox). What's left to trust is gVisor and the proxy's own code on that port, as with a central proxy.

- **DNS is open** (live): Modal answers DNS even with no public egress. This is weaker than SPACE, where the VM had no DNS: DNS lookups are a possible low-bandwidth exfiltration channel. A session token leaked that way is useless outside the sandbox, since only that sandbox can reach its proxy, and dies with the run.
- **No in-sandbox firewall**: `ip6tables` fails ("Failed to initialize nft: Protocol not supported"), as does the legacy backend.

### Why not one proxy on Modal's private network

The first design ran one always-on proxy (a Modal Cls with `i6pn=True`) and gave sandboxes `i6pn: true` in the same region. It failed intermittently: sandboxes placed on the same cloud provider as the proxy reached it in about 60 ms, and the rest never did, even within the same region. Modal places sandboxes on any cloud within a region, and i6pn doesn't cross clouds; pinning the cloud isn't available on every Modal plan. Along the way: the CIDR allowlist takes IPv4 only (an IPv6 CIDR is refused at create), region names are `us-east` and the like (`us-east-1` is refused), and the proxy's i6pn address changes whenever its container is replaced.

### A fixed proxy outside Modal

`AGENT_VAULT_PROXY_ADDRESS` instead sets a fixed IPv4 `host:port`, which becomes the agent container's only allowed CIDR (`/32`); no sidecar runs. Like SPACE's rules, a CIDR carries no port, so the proxy's host should expose nothing else. Hostnames and IPv6 are refused: the allowlist takes IPv4 only, and the domain allowlist matches only TLS on port 443, while Agent Proxy speaks plain HTTP on its own port. Such a proxy is reachable from outside the sandbox, so a leaked session token is usable from anywhere until it's revoked.

### Preflight checks

| Check | Expected |
|---|---|
| `HTTPS_PROXY` host | `agent-proxy:17323` (or the fixed address) |
| CA fetch and `GET /v1/models` through the proxy with the placeholder key | **200** |
| Direct Anthropic, TLS handshake to `160.79.104.10:443` | **blocked** |
| SSH (`:22`) on the proxy host | **blocked** (nothing listening) |
| DNS for `app.infisical.com` | resolves (reported, not checked) |
| Credential variables in the agent's environment | none |
| Agent uid | not 0 |
