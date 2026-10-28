# Slack agent in a sandbox, with Agent Vault (Atlas)

**Atlas is a Slack agent that runs every message in a disposable Firecracker VM.**

Each Slack message boots a fresh [SPACE](https://github.com/perplexityai/SPACE) sandbox, runs Claude Code inside it with a full shell, posts the answer in the thread, and deletes the sandbox. The VM never holds a real credential: its outbound calls go through [Infisical Agent Vault](https://infisical.com/docs/documentation/platform/agent-vault/overview), which attaches credentials on the way out.

This builds on [`slack-agent-basic`](../slack-agent-basic). There, each agent is one long-running container with custom tools and no shell. Here, the agent gets a shell, so it runs in a VM that exists for one message, can reach only the Agent Vault proxy, and holds only a session that dies with the run.

[SPACE and Agent Vault API notes](docs/contract.md) | [Slack app setup](docs/slack-app.md) | [Deployment](docs/deploy.md) | [Agent instructions](instructions/AGENTS.md)

## Why this design

An agent with a shell is only as safe as what it can reach and what it can leak. Atlas keeps both small:

- **One VM per message**: Every message gets its own SPACE Firecracker sandbox, deleted once the answer is posted. Nothing carries over between messages; a thread reply gets the thread so far as a transcript.
- **No credentials in the sandbox**: The VM gets a short-lived Agent Vault session token on stdin and a placeholder `ANTHROPIC_API_KEY`. The proxy swaps in the real key. The machine identity, the access bundle name and the Infisical API stay outside the VM.
- **Egress to one host**: Each sandbox is created with an egress policy that allows only the Agent Vault proxy. There is no DNS and no direct route to the internet.
- **Access chosen by the orchestrator**: The access bundle a run's session carries is picked by the orchestrator, never by the prompt or the agent. In this version every run gets `AGENT_VAULT_ACCESS_BUNDLE`.
- **Pinned proxy CA**: The sandbox verifies the proxy's CA against `AGENT_VAULT_CA_FINGERPRINT` before the agent starts. The bot refuses to start without it.
- **Crash-safe cleanup**: Session and sandbox IDs are journaled to `STATE_DIR` the moment they exist. The session is revoked first, then the sandbox deleted; anything a crashed process left behind is cleaned up on the next start.
- **Allowlist**: Only Slack user IDs or emails in `SLACK_ALLOWLIST` can run the agent. An empty list, unknown user or failed lookup denies.
- **Thread cleanup**: `@Atlas cleanup`, as the whole message, deletes every message the agent posted in that thread. It runs no sandbox and no model, and the allowlist still applies. Other people's messages stay, since a bot token can only delete its own.
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
      │ (outbound)   │ revoke│ credentials           │ credentials attached
┌─────┼──────────────┼───────┼───────────────────────┼─────────────────────┐
│     │              │       │                       │                     │
│  ┌──┴──────────────┴──┐    │       ┌───────────────┴─────────────────┐   │
│  │ Atlas              │    └───────┤ Agent Vault proxy               │   │
│  │ Docker container,  │            │ <proxy private IP>:17323        │   │
│  │ no inbound ports   │            └───────────────▲─────────────────┘   │
│  └─────────┬──────────┘                            │                     │
│            │ create, exec, delete                  │ the VM's only       │
│            │ (:8080 API, :8090 data plane)         │ allowed egress      │
│  ┌─────────▼───────────────────────────────────────┼──────────────────┐  │
│  │ SPACE                                           │                  │  │
│  │   ┌─────────────────────────────────────────────┴──────────────┐   │  │
│  │   │ Firecracker VM, one per message                            │   │  │
│  │   │                                                            │   │  │
│  │   │   infisical agent-vault run --ca-fingerprint=... -- claude │   │  │
│  │   │   stdin: session token, then the prompt                    │   │  │
│  │   │   no DNS, no internet, no route to Infisical               │   │  │
│  │   └────────────────────────────────────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└─ Private network ────────────────────────────────────────────────────────┘
```

Three boundaries hold it together:

- **Private network**: Atlas, SPACE and the proxy run on separate hosts in one private network. Atlas only makes outbound connections (Slack over Socket Mode, Infisical, SPACE) and publishes no ports.
- **VM egress**: a Firecracker VM may reach the proxy's port and nothing else: no DNS, no internet and no route to Infisical. See [Network layers](docs/contract.md#5-network-layers).
- **Credentials**: the Slack tokens, the SPACE token and the machine identity stay in Atlas. The VM gets only a short-lived session token; the proxy, which gets sessions and credentials from Infisical, attaches the real key on the way out.

A run, end to end:

1. A DM, or a channel message that mentions the bot, arrives over Socket Mode. Bot messages are dropped, and the sender is checked against the allowlist.
2. Atlas posts a `Thinking...` placeholder in the thread, or a queued notice if all `MAX_SANDBOXES` slots are busy.
3. It mints an Agent Vault [session](https://infisical.com/docs/documentation/platform/agent-vault/sessions) over the access bundle while the sandbox boots. The session TTL is the run timeout plus 5 minutes.
4. It runs a bootstrap script in the VM. The token is read from the first line of stdin, so it never appears in SPACE's command record; the rest of stdin is the prompt. The script writes [instructions/AGENTS.md](instructions/AGENTS.md) into the workspace and execs Claude Code under `infisical agent-vault run`.
5. Claude Code's `stream-json` output becomes progress edits on the placeholder (tool calls and narration, about one edit a second).
6. The final answer replaces the placeholder. Then the session is revoked and the sandbox deleted.

With the template cached on the node, a sandbox boots in 1 to 3 seconds.

## Prerequisites

- Node.js 20 or later.
- A running [SPACE](https://github.com/perplexityai/SPACE) deployment and an API token for it. SPACE's [installation guide](https://github.com/perplexityai/SPACE/blob/main/docs/installation.md) sets one up in a local Kind cluster.
- A SPACE template for the agent. See [The sandbox template](#the-sandbox-template).
- An Agent Vault [proxy](https://infisical.com/docs/documentation/platform/agent-vault/proxies) on the same private network as SPACE, with **Traffic Policy** set to **Access bundle hosts only**, and its CA fingerprint from the proxy's row on the Agent Vault **Proxies** page. Never take the fingerprint from what the address serves.
- An [access bundle](https://infisical.com/docs/documentation/platform/agent-vault/access-bundles) with an Anthropic service (`api.anthropic.com`) and any other APIs the agent should reach.
- An Infisical [machine identity](https://infisical.com/docs/documentation/platform/identities/machine-identities) with Universal Auth that is a **plain Agent Vault Member** granted only that access bundle. An Agent Vault Admin can mint sessions over any access bundle, which defeats the point.
- For the smoke test's preflight, a second access bundle that the identity is **not** granted.
- A Slack app. [docs/slack-app.md](docs/slack-app.md) has the manifest. Use a separate dev app locally.

## The sandbox template

SPACE boots each VM from a template. Atlas needs one with:

- The [Infisical CLI](https://infisical.com/docs/cli/overview), version 0.44.2 or later, for `infisical agent-vault run`.
- [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), not logged in. Atlas passes a placeholder API key, and the proxy attaches the real one.
- Node.js 24 or later, which supports `NODE_USE_ENV_PROXY`.
- Git, and whatever other tools the agent should have.
- A non-root user whose workspace is `/home/user/workspace`.

Build it with SPACE's template tooling ([Kind runbook](https://github.com/perplexityai/SPACE/blob/main/infra/space/kind/README.md)) and set `SPACE_TEMPLATE` to its name and tag, such as `coding-agent:v1`. The tag is required. Have SPACE prefetch the template on each node, or the first boot on a node pulls and unpacks it first, which takes about a minute.

## Run it locally

1. Install dependencies and create your env file:

   ```bash
   cd slack-agent-sandbox
   npm install
   cp .env.example .env.local
   ```

2. Fill in `.env.local`. If SPACE's API is only reachable on its host, open a tunnel in another terminal:

   ```bash
   ssh -N -L 8080:localhost:8080 -L 8090:localhost:8090 <user>@<SPACE host>
   ```

3. Check SPACE, Agent Vault and the sandbox network without Slack. `--preflight` runs no inference; the second command runs one paid Claude Code call:

   ```bash
   npm run smoke -- --preflight --ungranted-bundle <slug>
   npm run smoke -- --expect AGENT_VAULT_OK "Reply with AGENT_VAULT_OK"
   ```

4. Start the bot and message it in Slack:

   ```bash
   npm run start:slack
   ```

On start it cleans up anything a previous process left in `STATE_DIR`. Ctrl-C stops taking messages, aborts runs in progress, revokes their sessions, deletes their sandboxes and replies in their threads. Press it twice to quit at once; the next start cleans up the rest.

## Configuration

All configuration is environment variables, read from `.env.local` when present. Missing required variables are reported together at startup.

| Variable | Default | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | required | Bot User OAuth Token (`xoxb-...`). |
| `SLACK_APP_TOKEN` | required | App-level token with `connections:write` (`xapp-...`). |
| `SLACK_ALLOWLIST` | empty (deny all) | Slack user IDs and/or emails, comma- or space-separated. Emails only match members of the bot's own workspace or org. |
| `SPACE_API_URL` | required | SPACE management API, e.g. `http://localhost:8080` through a tunnel. |
| `SPACE_DATA_PLANE_URL` | required | SPACE data plane, e.g. `http://localhost:8090`. |
| `SPACE_API_TOKEN` | required | SPACE bearer token. |
| `SPACE_CA_FILE` | unset | Reserved; not yet used by the SPACE client. For a private CA, use `NODE_EXTRA_CA_CERTS` ([docs/deploy.md](docs/deploy.md#tls-and-secrets)). |
| `SPACE_TEMPLATE` | `coding-agent:v1` | Sandbox template. The tag is required. |
| `INFISICAL_DOMAIN` | `https://app.infisical.com` | Infisical instance. |
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` | required | Machine identity client ID. |
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` | required | Machine identity client secret. |
| `AGENT_VAULT_ACCESS_BUNDLE` | required | The access bundle every run's session carries. |
| `AGENT_VAULT_PROXY_ADDRESS` | required | The proxy's `host:port` as the sandbox reaches it. Also sets the sandbox egress policy. |
| `AGENT_VAULT_CA_FINGERPRINT` | required for the bot | Proxy CA pin, `SHA256:AA:BB:...`. Optional for the smoke test. |
| `HARNESS_MODEL` | Claude Code default | Model passed to `claude --model`. |
| `MAX_SANDBOXES` | `3` | Concurrent runs. Further messages wait in arrival order. |
| `RUN_TIMEOUT_MS` | `600000` | Per-run timeout. |
| `STATE_DIR` | `state` | Run records for crash cleanup. Use a persistent volume when deployed. |

## Agent instructions

[instructions/AGENTS.md](instructions/AGENTS.md) is the agent's system prompt, appended to Claude Code's own. It tells the agent it is answering in Slack and must write Slack mrkdwn, not GitHub markdown. It travels inside the bootstrap script, so it has to stay under about 100 KB; Atlas refuses to start otherwise.

## Smoke test

`npm run smoke` runs one prompt through the real SPACE deployment and Infisical without Slack, then checks with both that the session was revoked and the sandbox deleted. It exits 1 if the run failed or anything was left behind.

```bash
npm run smoke -- "Reply with AGENT_VAULT_OK"                     # one paid run
npm run smoke -- --expect AGENT_VAULT_OK "Reply with AGENT_VAULT_OK"
npm run smoke -- --preflight --ungranted-bundle <slug>            # no inference
```

`--preflight` mints, reads and revokes a session, confirms that the access bundle named by `--ungranted-bundle` is refused, and runs a probe in the VM instead of Claude Code to check the proxy, CA pin and network. Create that bundle and leave the identity ungranted: Infisical refuses a bundle that doesn't exist the same way, so a made-up name proves nothing. Smoke runs keep their own journal under `STATE_DIR/smoke`, so they never touch a running bot's records. Session tokens and identity credentials are never printed.

## Development

```bash
npm run start:slack   # Run the bot with tsx in watch mode
npm run smoke         # End-to-end check without Slack (see above)
npm test              # Unit tests (node:test, SPACE/Slack/Infisical faked)
npm run typecheck     # tsc --noEmit
npm run build         # Compile to dist/
npm start             # Run the compiled bot
```

| Path | What it does |
|---|---|
| [src/main.ts](src/main.ts) | Slack entry point: Bolt in Socket Mode, startup recovery, signal handling. |
| [src/gateway.ts](src/gateway.ts) | Slack events to runs; drops bots and non-human subtypes. Independent of Bolt. |
| [src/handler.ts](src/handler.ts) | Placeholder, progress edits, thread transcripts, final reply, dedup. |
| [src/run.ts](src/run.ts) | One run: slot, session, sandbox, bootstrap, streaming, cleanup. |
| [src/space.ts](src/space.ts) | SPACE client: create, exec over WebSocket with stdin, delete. |
| [src/vault.ts](src/vault.ts) | Infisical Universal Auth and Agent Vault sessions. |
| [src/claude.ts](src/claude.ts) | Claude Code harness: command line and `stream-json` parsing. |
| [src/access.ts](src/access.ts) | Allowlist check. |
| [src/journal.ts](src/journal.ts) | Run records on disk for crash cleanup. |
| [src/config.ts](src/config.ts) | Environment parsing and validation. |

## Operating notes

- **Cost**: every message is one paid Claude Code inference.
- **SPACE token**: rotate `SPACE_API_TOKEN` before it expires. An expired token shows up as SPACE `401` errors, and every run replies with an error.
- **Proxy re-enrollment**: if the proxy is re-enrolled, its CA changes. Pin the new fingerprint or every run fails before the agent starts.
- **Leaked sandboxes**: SPACE suspends idle sandboxes rather than deleting them. Every sandbox Atlas creates carries `metadata: {app: "atlas"}`, so leaks can be found.

## Limits of this version

- One access bundle for every user. Choosing access bundles per Slack user belongs in the handler, where the sender is known.
- No retries: a run that fails or times out replies with an error.
- No memory between messages beyond the Slack thread transcript.
- Claude Code is the only harness.

## License

MIT
