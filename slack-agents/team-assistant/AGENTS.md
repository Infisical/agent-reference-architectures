# AGENTS.md

A Slack assistant that runs Claude Code in a fresh Modal or Daytona sandbox for each message, through an Agent Vault session on behalf of the person who asked. `README.md` has the setup, and [What you need](README.md#what-you-need) lists every value.

## Commands

Run from this folder:

```
npm ci
npm run typecheck
```

## How it works

- `src/` is the orchestrator. It runs outside the sandboxes, holds the Slack tokens, the Modal token or Daytona API key, and the machine identity's client secret, and never runs Claude Code itself
- `src/vault.ts` starts each session with the Infisical Node.js SDK, with `onBehalfOfUserEmail` set to the sender's Slack email, over the access bundle. Keep sessions on behalf of the sender: never start one as the identity itself, or the agent would act with the identity's own access
- `src/sandbox.ts` is what the runner needs from a platform, and `SANDBOX_PROVIDER` picks `src/modal.ts` or `src/daytona.ts`. Each follows the Agent Vault guide for its platform. A new platform implements the same `Sandboxes` interface
- On both platforms, the agent's sandbox reaches only its run's proxy: Modal through `outboundCidrAllowlist: []` with the proxy as a sidecar, Daytona through `networkBlockAll` and an allowlist of the linked proxy sandbox's address. Keep it that way: the proxy is the agent's only way out
- On Daytona, every command in the agent's sandbox runs without Daytona's own `HTTP_PROXY` and `HTTPS_PROXY`, which point at a proxy that refuses these requests. `agent-vault run` replaces them for Claude Code, but the wait for the proxy and the smoke probe call `curl` directly, and fail through Daytona's proxy. Keep `WITHOUT_DAYTONA_PROXY` in front of every command there
- The session token reaches the agent as input, never in a command, because the platforms record commands. A run stops the proxy, revokes the session, and deletes the sandbox when it ends, whatever happened
- `mcp.json` lists the MCP servers by URL with no credentials. A new server needs both a member-provided service in the access bundle and an entry in `mcp.json`
- Replies that don't mention the bot run only when `ANTHROPIC_API_KEY` is set. Without it, every reply in the bot's threads would start a sandbox

## Setting it up for a person

1. Ask the person to complete steps 1 to 5 of the README in Slack and Agent Vault, and which sandbox platform they use. Give them the exact names: the `team-assistant` proxy, access bundle, and machine identity.
2. Ask for the settings that aren't secret, and write them to `.env` from `.env.example`. Never ask for the tokens, the client secret, the Modal token, or the Daytona API key. The person fills in `docker/team-assistant.env` themselves.
3. Run the two smoke checks from Step 6 of the README, then start the orchestrator.
4. Have the person DM the bot and ask about something in one of their tools. An answer from their account confirms Slack, the session on their behalf, the sandbox platform, and their sign-in.

## Failures and their causes

| Symptom | Cause |
| --- | --- |
| The bot replies "Sorry, I can't act for you yet" | The delegation doesn't cover the person, or the email on their Slack profile isn't the email of their Infisical account. The log has Infisical's message |
| `The Agent Vault proxy didn't start in the sidecar` | The proxy token is wrong or was rotated. The error ends with the proxy's log |
| `the proxy at ... serves a certificate authority with fingerprint X, not the pinned Y` | The proxy's token was rotated or the proxy was recreated, which changes its fingerprint. Copy it again from the **Certificate Authority** column |
| The agent says a tool isn't connected | The person hasn't connected their account to that MCP service, or the service isn't in the access bundle |
| The agent says it can't reach a host | The host isn't in the access bundle. The sandbox has no other way out |
| `Profile is missing credentials` from Modal | `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` aren't set |
| The bot answers some messages and not others | Another orchestrator is running with the same Slack app, and Slack splits events between them |
| `DAYTONA_API_KEY` errors, or `Daytona` can't authenticate | `DAYTONA_API_KEY` isn't set, or `SANDBOX_PROVIDER` is `daytona` with no key |
| On Daytona, the proxy doesn't answer the agent's sandbox | The organization is below Tier 3, so the agent's sandbox can't be limited to the proxy, or a command in it still has Daytona's `HTTPS_PROXY` |
