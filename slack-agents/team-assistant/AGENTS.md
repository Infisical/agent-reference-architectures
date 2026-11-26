# AGENTS.md

A Slack assistant that runs Claude Code in a fresh Modal sandbox for each message, through an Agent Vault session on behalf of the person who asked. `README.md` has the setup, and [What you need](README.md#what-you-need) lists every value.

## Commands

Run from this folder:

```
npm ci
npm run typecheck
```

## How it works

- `src/` is the orchestrator. It runs outside Modal, holds the Slack and Modal tokens and the machine identity's client secret, and never runs Claude Code itself
- `src/vault.ts` starts each session with the Infisical Node.js SDK, with `onBehalfOfUserEmail` set to the sender's Slack email, over the access bundle. Keep sessions on behalf of the sender: never start one as the identity itself, or the agent would act with the identity's own access
- `src/modal.ts` creates each sandbox with `outboundCidrAllowlist: []` and the proxy as a sidecar. Keep the allowlist empty: the sidecar is the agent's only way out
- `src/run.ts` sends the session token on stdin, never in the command, because Modal records commands. It revokes the session and terminates the sandbox when a run ends, whatever happened
- `mcp.json` lists the MCP servers by URL with no credentials. A new server needs both a member-provided service in the access bundle and an entry in `mcp.json`
- Replies that don't mention the bot run only when `ANTHROPIC_API_KEY` is set. Without it, every reply in the bot's threads would start a sandbox

## Setting it up for a person

1. Ask the person to complete steps 1 to 5 of the README in Slack, Agent Vault, and Modal. Give them the exact names: the `team-assistant` proxy, access bundle, and machine identity.
2. Ask for the settings that aren't secret, and write them to `.env` from `.env.example`. Never ask for the tokens, the client secret, or the Modal token. The person fills in `docker/team-assistant.env` themselves.
3. Run the two smoke checks from Step 6 of the README, then start the orchestrator.
4. Have the person DM the bot and ask about something in one of their tools. An answer from their account confirms Slack, the session on their behalf, Modal, and their sign-in.

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
