# AGENTS.md

A Hermes Agent gateway on Telegram, behind Infisical Agent Vault. There's no code here: Hermes is installed with its own installer, and this folder holds the deployment. `README.md` has the setup.

## How it works

- `infisical agent-vault run` wraps `hermes gateway run` and sets `HTTPS_PROXY` and the CA variables, which route Hermes's traffic, including its Telegram client, through the proxy. Don't set `HTTPS_PROXY` in `~/.hermes/.env`, or a Telegram proxy in `TELEGRAM_PROXY` or `config.yaml`: `agent-vault run` sets the proxy URL with the session token in it, and Hermes's Telegram proxy setting takes priority over `HTTPS_PROXY`
- Hermes's environment holds placeholders only: `ANTHROPIC_API_KEY=agent-vault` and `TELEGRAM_BOT_TOKEN=avplaceholder-hermes-telegram`. Don't put a real key in `~/.hermes/.env`, and don't run `hermes setup` or `hermes model`, which save keys there
- `HERMES_TELEGRAM_DISABLE_FALLBACK_IPS=true` keeps the Telegram client on `api.telegram.org`. Without it, Hermes can connect to Telegram by IP address, and the proxy can't broker those requests
- Set Hermes's config with `hermes config set`, and don't replace `config.yaml` with a copy: Hermes tracks a schema version in it
- Don't use `hermes gateway install`. Its systemd unit can't start the gateway inside `agent-vault run`, so `digitalocean/hermes-gateway.service` replaces it

## Setting it up for a person

1. Ask the person to complete steps 1 to 4 of the README in Telegram and Agent Vault. Give them the exact names: the `hermes` access bundle, its two services, and the placeholder `avplaceholder-hermes-telegram` with **URL Path** selected. If they use other names, use theirs in the deployment files.
2. Ask for their numeric Telegram user ID, and set it in `platforms.telegram.extra.allow_from`. Never ask for the bot token or the client secret.
3. Deploy with steps 5 to 9 of the README. The person fills in the secret files themselves.
4. Have the person message the bot. A reply confirms the session, Telegram, and Anthropic.
5. Check the block. Asking Hermes to fetch a host outside the bundle, such as `api.open-meteo.com`, should come back refused by the proxy.

## Failures and their causes

| Symptom | Cause |
| --- | --- |
| `No access bundle named 'hermes' is granted to you` | The identity logged in, but has no access to the `hermes` access bundle. Select **Manage Access** on the access bundle and grant it |
| `the proxy at ... serves a certificate authority with fingerprint X, not the pinned Y` | The proxy's token was rotated or the proxy was recreated, which changes its fingerprint. Compare with the **Certificate Authority** column on the **Proxies** page |
| `not the pinned --` | The fingerprint variable is empty, so the flag took `--` as its value |
| `Route POST:/api/v1/agent-vault/proxy/login not found` | The Infisical CLI is older than 0.45.13 |
| Telegram rejects the token, and the gateway stops trying | The Telegram substitution doesn't match `avplaceholder-hermes-telegram` exactly, or **URL Path** isn't selected under **Replace In**. Hermes doesn't retry a rejected token, so restart the service after fixing it |
| The installer fails with `libatomic.so.1: cannot open shared object file` | Install `libatomic1` and run the installer again |
| Hermes keeps getting authentication errors after the credential is fixed | Hermes marks a rejected key as exhausted. Run `hermes auth reset anthropic` as the Hermes user, then restart the gateway |
| The bot doesn't answer you, and the log shows your message | Your user ID isn't in `platforms.telegram.extra.allow_from` |
