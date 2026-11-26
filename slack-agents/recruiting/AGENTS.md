# AGENTS.md

A Slack agent that runs Claude Code behind Infisical Agent Vault, and answers questions about hiring from Ashby. `README.md` has the setup, and [What you need](README.md#what-you-need) lists every value.

## Commands

Run from this folder:

```
npm ci
npm run typecheck
```

## How it works

- `src/` is a Slack bridge. It reads Slack and runs `claude -p` for each message. Claude Code does the work with Ashby's MCP tools
- Claude Code inherits the proxy settings from `infisical agent-vault run`. Keep it that way: no per-message `agent-vault run`, and no Agent Vault code in `src/`
- `mcp.json` lists Ashby's MCP server by its URL, with no credential. The proxy attaches the OAuth token. A new MCP server needs both a service in the access bundle and an entry in `mcp.json`
- The proxy hides the Ashby tools that aren't in the service's **Allowed Tools** from Claude Code, and refuses calls to them, which keeps the agent read-only. Don't widen it to write tools without asking the person

## Setting it up for a person

1. Ask the person to complete steps 1 to 4 of the README in Slack and Agent Vault. Give them the exact names: the `recruiting` access bundle, its three services, and the placeholders `xoxb-avplaceholder-recruiting-bot` and `xapp-avplaceholder-recruiting-app`. If they use other names, use theirs in `.env` and the deployment files.
2. Ask for the settings that aren't secret, and write them to `.env` from `.env.example`. Never ask for the tokens or the client secret, and never ask the person to sign in to Ashby from the agent.
3. Deploy with Step 5 of the README, with Docker or on a VM. The person fills in the secret file themselves.
4. Have the person mention the bot in its channel and ask which jobs are open. An answer that lists them confirms the session, Slack, Anthropic, and Ashby.

## Failures and their causes

| Symptom | Cause |
| --- | --- |
| `the proxy at ... serves a certificate authority with fingerprint X, not the pinned Y` | Another proxy is answering on that port, or the proxy's token was rotated or the proxy was recreated, which changes its fingerprint. Compare with the **Certificate Authority** column on the **Proxies** page |
| `not the pinned --` | The fingerprint variable is empty, so the flag took `--` as its value |
| `No Agent Vault project is set` | Set `INFISICAL_AGENT_VAULT_PROJECT_ID` |
| `Route POST:/api/v1/agent-vault/proxy/login not found` | The Infisical CLI is older than 0.45.13 |
| The agent says it can't reach Ashby, or answers without Ashby's data | The Ashby service isn't in the access bundle, its URL doesn't match `mcp.json`, or it isn't authorized yet |
| The proxy returns a `502` that says to reconnect | Ashby no longer accepts the service's OAuth token. Select **Reauthorize** on the Ashby service, then restart the agent |
| The agent says it has no tool for something Ashby can do | The tool isn't in the Ashby service's **Allowed Tools**. Add it only if it reads data |
| The bot replies "Sorry, I can only help people on my allowlist" | Slack, the proxy, and the session all work. The email on the person's Slack profile isn't in `AGENT_ALLOWLIST`, or the app lacks the `users:read.email` scope |
| The bot never connects to Slack | The Slack placeholders in `.env` don't match the substitutions exactly, the two substitutions are swapped, or the Slack service lacks `*.slack.com` |
| The bot can't read earlier messages in a thread | The app lacks `groups:history` for a private channel, or `channels:history` for a public one |
