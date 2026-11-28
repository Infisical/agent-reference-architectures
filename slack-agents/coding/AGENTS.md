# AGENTS.md

A Slack agent that runs Claude Code behind Infisical Agent Vault, and opens pull requests on GitHub. `README.md` has the setup, and [What you need](README.md#what-you-need) lists every value.

## Commands

Run from this folder:

```
npm ci
npm run typecheck
```

## How it works

- `src/` is a Slack bridge. It reads Slack and runs `claude -p` for each message. Claude Code does the work with its own tools
- Claude Code inherits the proxy settings from `infisical agent-vault run`. Keep it that way: no per-message `agent-vault run`, and no Agent Vault code in `src/`
- The code sends no credentials and holds no API keys. Integrations come from HTTP services in the access bundle, reached with CLIs like `gh` or with `curl`, and from MCP servers in an optional `mcp.json`. Don't add tools in TypeScript or API key environment variables
- A new MCP server needs both a service in the access bundle and an entry in `mcp.json`. A CLI that refuses to run without a token, like `gh`, gets a placeholder in `.env`

## Setting it up for a person

1. Ask the person to complete steps 1 to 4 of the README in Slack and Agent Vault. Give them the exact names: the `coding` access bundle, its three services, and the placeholders `xoxb-avplaceholder-coding-bot` and `xapp-avplaceholder-coding-app`. If they use other names, use theirs in `.env` and the deployment files.
2. Ask for the settings that aren't secret, and write them to `.env` from `.env.example`. Never ask for the tokens or the client secret.
3. Deploy with Step 5 of the README, with Docker or on a VM. The person fills in the secret file themselves.
4. Have the person mention the bot in its channel and ask what the repo does and how its tests run. An answer that describes the repo confirms the session, Slack, Anthropic, and GitHub.
5. Check the block. Asking for a host outside the bundle, such as `api.open-meteo.com`, should come back refused by the proxy.

## Failures and their causes

| Symptom | Cause |
| --- | --- |
| `the proxy at ... serves a certificate authority with fingerprint X, not the pinned Y` | Another proxy is answering on that port, or the proxy's token was rotated or the proxy was recreated, which changes its fingerprint. Compare with the **Certificate Authority** column on the **Proxies** page |
| `not the pinned --` | The fingerprint variable is empty, so the flag took `--` as its value |
| `No Agent Vault project is set` | Set `INFISICAL_AGENT_VAULT_PROJECT_ID` |
| `Route POST:/api/v1/agent-vault/proxy/login not found` | The Infisical CLI is older than 0.45.13 |
| An MCP server's tools are missing | Its service isn't in the access bundle, or its entry in `mcp.json` is wrong. Claude Code answers without the server's tools |
| The bot replies "Sorry, I can only help people on my allowlist" | Slack, the proxy, and the session all work. The email on the person's Slack profile isn't in `AGENT_ALLOWLIST`, or the app lacks the `users:read.email` scope |
| The bot never connects to Slack | The Slack placeholders in `.env` don't match the substitutions exactly, the two substitutions are swapped, or the Slack service lacks `*.slack.com` |
| `git clone` fails with 403 | The GitHub service isn't in the bundle, or its hosts lack `github.com` |
| `git commit` fails with "Please tell me who you are" | The `GIT_` settings in `.env` are empty |
| `gh pr create` or `git push` fails with 403 | The GitHub token lacks Contents or Pull requests write access, or a branch rule blocks the push |
| `gh` or `git` fails with 409 "Git Repository is empty" | The repo in `GITHUB_REPO` has no commits yet |
| Proxy logs `refused, the session is no longer valid` for hosts the agent doesn't use | Another process on the machine routes through the proxy with an old session |
