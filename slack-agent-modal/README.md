# Slack agent in a Modal Sandbox, with Agent Vault (Apollo)

**Apollo is a Slack agent that runs every message in a disposable Modal Sandbox.**

Each Slack message starts a fresh sandbox, runs Claude Code inside it, posts the answer in the thread, and terminates the sandbox. The sandbox never holds a real credential: its outbound calls go through an [Infisical Agent Vault](https://infisical.com/docs/documentation/platform/agent-vault/overview) Agent Proxy running as a sidecar in the same sandbox, which injects credentials on the wire.

This builds on [`slack-agent-sandbox`](../slack-agent-sandbox) (Atlas), which does the same on [SPACE](https://github.com/perplexityai/SPACE) Firecracker VMs. Apollo moves the sandboxes to [Modal](https://modal.com/docs/guide/sandboxes), so there is no sandbox cluster to run, and puts a copy of the Agent Vault proxy inside every sandbox, so the agent has no network path out at all except through it.

[Modal and Agent Vault API notes](docs/contract.md) | [Slack app setup](docs/slack-app.md) | [Deployment](docs/deploy.md) | [Agent instructions](instructions/AGENTS.md)

## Why this design

An agent with a shell is only as safe as what it can reach and what it can leak. Apollo keeps both small:

- **One sandbox per message**: Every message gets its own Modal Sandbox, terminated once the answer is posted. Nothing carries over between messages; a thread reply gets the thread so far as a transcript.
- **No credentials in the sandbox**: The sandbox gets a short-lived Agent Vault session token on stdin and a placeholder `ANTHROPIC_API_KEY`. Agent Proxy swaps in the real key. The machine identity, the bundle name, the Modal token and the Infisical API stay outside the sandbox.
- **No public egress**: The agent's container is created with an empty outbound allowlist, so it can reach nothing on the internet. Its only way out is Agent Proxy, which runs as a sidecar in the same sandbox: a separate container, with its own gVisor kernel and filesystem, that only that sandbox can reach. DNS still resolves (see [Limitations](#limitations-of-this-version)).
- **Not root**: The agent runs as `user` (uid 2000) through `runuser`.
- **Access chosen by the orchestrator**: The access bundle a run's session carries is picked by the orchestrator, never by the prompt or the agent. In this version every run gets `AGENT_VAULT_ACCESS_BUNDLE`.
- **Pinned proxy CA**: The sandbox verifies Agent Proxy's CA against `AGENT_VAULT_CA_FINGERPRINT` before the agent starts. The bot refuses to start without it.
- **Crash-safe cleanup**: Session and sandbox IDs are journaled to `STATE_DIR` the moment they exist. The session is revoked first, then the sandbox terminated. On the next start, anything the journal lists is cleaned up, and any bot-tagged sandbox still running in the Modal App is terminated. Every sandbox also has a hard Modal timeout (run timeout plus 5 minutes).
- **Allowlist**: Only Slack user IDs or emails in `SLACK_ALLOWLIST` can run the agent. An empty list, unknown user or failed lookup denies.
- **Pluggable harness**: Claude Code is one adapter ([src/claude.ts](src/claude.ts)). Another agent CLI is another implementation of `Harness` ([src/harness.ts](src/harness.ts)).

## How it works

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Public internet                                                          │
│                                                                          │
│   Slack            Infisical               api.anthropic.com   ...       │
│     ▲              ▲       ▲                       ▲                     │
└─────┼──────────────┼───────┼───────────────────────┼─────────────────────┘
      │ Socket Mode  │ mint, │ sessions,             │ outbound HTTPS,
      │ (outbound)   │ revoke│ credentials           │ credentials injected
┌─────┴──────────────┴──┐    │                       │
│ Apollo                │    │                       │
│ Docker container,     │    │                       │
│ no inbound ports      │    │                       │
└─────────┬─────────────┘    │                       │
          │ create, exec,    │                       │
          │ terminate        │                       │
          │ (Modal API)      │                       │
┌─────────▼──────────────────┼───────────────────────┼─────────────────────┐
│ Modal                      │                       │                     │
│   ┌────────────────────────┼───────────────────────┼──────────────┐      │
│   │ Sandbox, per message   │                       │              │      │
│   │                        │                       │              │      │
│   │   ┌────────────────────┴───────────────────────┴──────────┐   │      │
│   │   │ Sidecar "agent-proxy": infisical agent-vault proxy    │   │      │
│   │   │ from a read-only copy of the agent-proxy-state Volume │   │      │
│   │   └──────────────────────────▲────────────────────────────┘   │      │
│   │                              │ agent-proxy:17323, the only    │      │
│   │                              │ way out (no public egress)     │      │
│   │   ┌──────────────────────────┴────────────────────────────┐   │      │
│   │   │ Agent container                                       │   │      │
│   │   │   runuser -u user -- infisical agent-vault run        │   │      │
│   │   │     --ca-fingerprint=... -- claude                    │   │      │
│   │   │   stdin: session token, then the prompt               │   │      │
│   │   └───────────────────────────────────────────────────────┘   │      │
│   └───────────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────────┘
```

A run, end to end:

1. A DM, or a channel message that mentions the bot, arrives over Socket Mode. Bot messages are dropped, and the sender is checked against the allowlist.
2. Apollo posts a `Thinking...` placeholder in the thread, or a queued notice if all `MAX_SANDBOXES` slots are busy.
3. It mints an Agent Vault session over the access bundle while the sandbox starts. The session TTL is the run timeout plus 5 minutes. Once the sandbox is up, it adds the Agent Proxy sidecar and waits, about a second, until the proxy serves.
4. It runs a bootstrap script in the agent's container as `user`, pointed at `agent-proxy:17323`. The token is read from the first line of stdin, so it never appears in the command Modal records; the rest of stdin is the prompt. The script writes [instructions/AGENTS.md](instructions/AGENTS.md) into the workspace and execs Claude Code under `infisical agent-vault run`.
5. Claude Code's `stream-json` output becomes progress edits on the placeholder (tool calls and narration, about one edit a second).
6. The final answer replaces the placeholder. Then the session is revoked and the sandbox terminated.

Only [src/modal.ts](src/modal.ts), [src/image.ts](src/image.ts), the Modal part of [src/config.ts](src/config.ts) and the enrollment job in [proxy/agent_proxy.py](proxy/agent_proxy.py) differ from [Atlas](../slack-agent-sandbox) in substance; the Slack gateway, handler, runner, vault, journal and harness are the same code.

## Getting started

You need:

- Node.js 20 or later.
- A Modal workspace token (`MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`).
- Agent Proxy enrolled onto a Modal Volume in the same workspace ([Agent Proxy on Modal](docs/deploy.md#agent-proxy-on-modal)), and its CA fingerprint from the proxy's row on the Agent Vault Proxies page (`rootCaFingerprint`). Never take the fingerprint from what the address serves.
- An Infisical machine identity with Universal Auth that is a **plain Agent Vault member** granted only that access bundle. An Agent Vault admin can mint sessions over any bundle, which defeats the point.
- For the smoke test's preflight, a second access bundle that the identity is **not** granted.
- A dev Slack app, separate from any deployed one. [docs/slack-app.md](docs/slack-app.md) has the manifest.

1. Install dependencies and create your env file:

```bash
npm install
cp .env.example .env.local
```

2. Check Modal, Agent Vault and the sandbox network without Slack. `--preflight` runs no inference; the second command runs one paid Claude Code call. The first run builds the sandbox image, which takes a few minutes; Modal caches it after that.

```bash
npm run smoke -- --preflight --ungranted-bundle <slug>
npm run smoke -- --expect AGENT_VAULT_OK "Reply with AGENT_VAULT_OK"
```

3. Start the bot and message it in Slack:

```bash
npm run start:slack
```

On start it builds or resolves the sandbox image and cleans up anything a previous process left behind. Ctrl-C stops taking messages, aborts runs in progress, revokes their sessions, terminates their sandboxes and replies in their threads. Press it twice to quit at once; the next start cleans up the rest.

## Configuration

All configuration is environment variables, read from `.env.local` when present. Missing required variables are reported together at startup.

| Variable | Default | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | required | Bot User OAuth Token (`xoxb-...`). |
| `SLACK_APP_TOKEN` | required | App-level token with `connections:write` (`xapp-...`). |
| `SLACK_ALLOWLIST` | empty (deny all) | Slack user IDs and/or emails, comma- or space-separated. Emails only match members of the bot's own workspace or org. |
| `MODAL_TOKEN_ID` | required | Modal token ID (`ak-...`). |
| `MODAL_TOKEN_SECRET` | required | Modal token secret (`as-...`). |
| `MODAL_ENVIRONMENT` | workspace default | Modal environment for the App, image and sandboxes. |
| `MODAL_APP_NAME` | `apollo` | Modal App every sandbox is created in (created if missing). One bot per App. |
| `MODAL_IMAGE` | `builtin` | Sandbox image: `builtin` ([src/image.ts](src/image.ts)), an image ID (`im-...`), or a published image name. |
| `MODAL_SANDBOX_CPU` | `2` | CPU cores reserved per sandbox; may be fractional. |
| `MODAL_SANDBOX_MEMORY_MIB` | `2048` | Memory reserved per sandbox. |
| `INFISICAL_DOMAIN` | `https://app.infisical.com` | Infisical instance. |
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` | required | Machine identity client ID. |
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` | required | Machine identity client secret. |
| `AGENT_VAULT_ACCESS_BUNDLE` | required | The access bundle every run's session carries. |
| `AGENT_VAULT_PROXY_VOLUME` | required (or the next) | Modal Volume holding Agent Proxy's enrollment (`agent-proxy-state`, written by [proxy/agent_proxy.py](proxy/agent_proxy.py)). Every sandbox runs the proxy from it as a sidecar. |
| `AGENT_VAULT_PROXY_ADDRESS` | unset | Instead of the above, a proxy outside Modal at a fixed IPv4 `host:port`, which becomes each sandbox's only allowed public destination. |
| `AGENT_VAULT_CA_FINGERPRINT` | required for the bot | Proxy CA pin, `SHA256:AA:BB:...`. Optional for the smoke test. |
| `HARNESS_MODEL` | Claude Code default | Model passed to `claude --model`. |
| `MAX_SANDBOXES` | `3` | Concurrent runs. Further messages wait in arrival order. |
| `RUN_TIMEOUT_MS` | `600000` | Per-run timeout. Each sandbox's Modal timeout is this plus 5 minutes. |
| `STATE_DIR` | `state` | Run records for crash cleanup. Use a persistent volume when deployed. |

## Agent instructions

[instructions/AGENTS.md](instructions/AGENTS.md) is the agent's system prompt, appended to Claude Code's own. It tells the agent it is answering in Slack and must write Slack mrkdwn, not GitHub markdown. It travels inside the bootstrap script, so it has to stay under about 100 KB; Apollo refuses to start otherwise.

## MCP servers

Every run gets the remote MCP servers in `MCP_SERVERS` ([src/claude.ts](src/claude.ts)), passed to Claude Code with `--mcp-config`: as an example, Linear (`https://mcp.linear.app/mcp`). The sandbox can't run an OAuth flow, so each server sends a placeholder `Authorization: Bearer` header and Agent Proxy replaces it with the real credential. For Linear to work, the access bundle needs a service for `mcp.linear.app` that injects `Authorization: Bearer <Linear API key>`. Without one, the server fails to connect and the agent answers without Linear tools.

## Smoke test

`npm run smoke` runs one prompt through Modal and Infisical without Slack, then checks with both that the session was revoked and the sandbox terminated. It exits 1 if the run failed or anything was left behind.

```bash
npm run smoke -- "Reply with AGENT_VAULT_OK"                     # one paid run
npm run smoke -- --expect AGENT_VAULT_OK "Reply with AGENT_VAULT_OK"
npm run smoke -- --preflight --ungranted-bundle <slug>            # no inference
```

`--preflight` mints, reads and revokes a session, confirms that the access bundle named by `--ungranted-bundle` is refused, and runs a probe in the sandbox instead of Claude Code to check the proxy, CA pin, network and that the agent isn't root. Create that bundle and leave the identity ungranted: Infisical refuses a bundle that doesn't exist the same way, so a made-up name proves nothing. Smoke runs keep their own journal under `STATE_DIR/smoke` and tag their sandboxes `role=smoke`, so they never touch a running bot's records and the bot's sweep never touches them (two smoke runs at once would sweep each other's sandboxes, as they already share a journal). Session tokens and identity credentials are never printed.

## Development

```bash
npm run start:slack   # Run the bot with tsx in watch mode
npm run smoke         # End-to-end check without Slack (see above)
npm test              # Unit tests (node:test, Modal/Slack/Infisical faked)
npm run typecheck     # tsc --noEmit
npm run build         # Compile to dist/
npm start             # Run the compiled bot
```

| Path | What it does |
|---|---|
| [src/main.ts](src/main.ts) | Slack entry point: Bolt in Socket Mode, image build, startup recovery, signal handling. |
| [src/gateway.ts](src/gateway.ts) | Slack events to runs; drops bots and non-human subtypes. Independent of Bolt. |
| [src/handler.ts](src/handler.ts) | Placeholder, progress edits, thread transcripts, final reply, dedup. |
| [src/run.ts](src/run.ts) | One run: slot, session, sandbox, bootstrap, streaming, cleanup; startup recovery and sweep. |
| [src/modal.ts](src/modal.ts) | Modal client: create, exec with stdin as `user`, terminate, sweep; how sandboxes reach Agent Proxy (egress, and the proxy sidecar each one starts). |
| [src/image.ts](src/image.ts) | The sandbox image and `MODAL_IMAGE` resolution. |
| [proxy/agent_proxy.py](proxy/agent_proxy.py) | One-shot job that enrolls Agent Proxy and saves the enrollment on a Modal Volume, for the sidecars. |
| [src/vault.ts](src/vault.ts) | Infisical Universal Auth and Agent Vault sessions. |
| [src/claude.ts](src/claude.ts) | Claude Code harness: command line and `stream-json` parsing. |
| [src/access.ts](src/access.ts) | Allowlist check. |
| [src/journal.ts](src/journal.ts) | Run records on disk for crash cleanup. |
| [src/config.ts](src/config.ts) | Environment parsing and validation. |

## Operating notes

- **Cost**: every message is one paid Claude Code inference, plus Modal sandbox time.
- **Proxy re-enrollment**: if Agent Proxy is re-enrolled, its CA changes. Pin the new fingerprint or every run fails before the agent starts.
- **Agent Proxy fails to start**: a run whose sidecar doesn't serve within 30 s fails with "Agent Proxy didn't start in the sidecar" and the end of the proxy's log, and is cleaned up like any failed run. Every sidecar runs a copy of the same proxy (one identity, one CA), so there's no shared proxy to go down.
- **Image changes**: editing [src/image.ts](src/image.ts) rebuilds the changed layers on the next start. For a pinned deployment, publish the image and set `MODAL_IMAGE` to its name or ID.
- **Leaked sandboxes**: every sandbox carries `tags: {app: "apollo", role: "bot" | "smoke"}` and a hard timeout, so leaks can be found and expire on their own.

## Limitations of this version

- **DNS is open in the sandbox**: Modal allows DNS even under an egress allowlist. SPACE gives the VM no DNS at all, so this is a possible low-bandwidth exfiltration channel that Atlas doesn't have.
- **Sidecars are a Modal beta feature** (`experimentalSidecars` in the SDK); the API may change.
- **Every sidecar holds a copy of the proxy's credentials**: its access token, which has no expiry until Infisical revokes it, and its CA key. The agent's container can't read them (tested as root: [contract section 5](docs/contract.md#5-network)), but they sit in every sandbox rather than in one place.
- **Infisical Cloud only for the sidecar proxy**: the sidecar passes no `INFISICAL_DOMAIN`, so another Infisical instance needs that added in `startProxy` ([src/modal.ts](src/modal.ts)).
- One access bundle for every user. Choosing bundles per Slack user belongs in the handler, where the sender is known.
- No retries: a run that fails or times out replies with an error.
- No memory between messages beyond the Slack thread transcript.
- Claude Code is the only harness.

## License

MIT
