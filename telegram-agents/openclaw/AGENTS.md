# AGENTS.md

An OpenClaw gateway on Telegram, behind Infisical Agent Vault. There's no code here: OpenClaw is installed from npm, and this folder holds its config and the deployments. `README.md` has the setup.

## How it works

- `infisical agent-vault run` wraps `openclaw gateway run` and sets `OPENCLAW_PROXY_URL`, which routes all of OpenClaw's traffic, including its Telegram client, through the proxy. Don't set `proxy.proxyUrl` in `openclaw.json`: it takes precedence over the variable, and would need a session token pasted into the config
- OpenClaw's environment holds placeholders only: `ANTHROPIC_API_KEY=agent-vault` and `TELEGRAM_BOT_TOKEN=avplaceholder-openclaw-telegram`. Don't put a real key in `openclaw.json` or `~/.openclaw/.env`, and don't run `openclaw onboard`, which saves keys to OpenClaw's credential store
- Don't use `openclaw gateway install`. Its systemd unit can't start the gateway inside `agent-vault run`, so `digitalocean/openclaw-gateway.service` replaces it

## Setting it up for a person

1. Ask the person to complete steps 1 to 4 of the README in Telegram and Agent Vault. Give them the exact names: the `openclaw` access bundle, its two services, and the placeholder `avplaceholder-openclaw-telegram` with **URL Path** selected. If they use other names, use theirs in the deployment files.
2. Ask for their numeric Telegram user ID, and write it to `allowFrom` in `openclaw.json`. Never ask for the bot token or the client secret.
3. Deploy with `digitalocean/`. The person fills in the secret files themselves.
4. Have the person message the bot. A reply confirms the session, Telegram, and Anthropic.
5. Check the block. Asking OpenClaw to fetch a host outside the bundle, such as `api.open-meteo.com`, should come back refused by the proxy.

## Failures and their causes

| Symptom | Cause |
| --- | --- |
| `the proxy at ... serves a certificate authority with fingerprint X, not the pinned Y` | The proxy's token was rotated or the proxy was recreated, which changes its fingerprint. Compare with the **Certificate Authority** column on the **Proxies** page |
| `not the pinned --` | The fingerprint variable is empty, so the flag took `--` as its value |
| `No access bundle named 'openclaw' is granted to you` | The identity logged in, but has no access to the `openclaw` access bundle. Select **Manage Access** on the access bundle and grant it |
| `Route POST:/api/v1/agent-vault/proxy/login not found` | The Infisical CLI is older than 0.45.13 |
| Telegram reports `getMe returned 404` | The Telegram substitution doesn't match `avplaceholder-openclaw-telegram` exactly, or **URL Path** isn't selected under **Replace In** |
| The gateway refuses to start without `gateway.mode=local` | `openclaw.json` is missing from OpenClaw's state folder, or lost the `gateway` block |
| The bot doesn't answer you, and the log shows your message | Your user ID isn't in `channels.telegram.allowFrom` |
| Channels don't start after several restarts, and the log mentions a crash-loop breaker | The gateway restarted several times in five minutes. Fix the cause, then restart the service |
