# On-call agent on Docker

Runs the on-call agent and an Agent Vault proxy with Docker Compose. The agent reaches the internet only through the proxy.

## What you need

- Docker with Compose
- Steps 1 to 4 of the [on-call agent's README](../README.md) completed, so the Slack app, proxy, access bundle, and machine identity exist
- The proxy token, the machine identity's client ID and client secret, the Agent Vault project ID, and the proxy's fingerprint
- The settings for `.env`, listed in [What you need](../README.md#what-you-need)

## Run it

1. Copy `../.env.example` to `../.env`, and fill in the values that aren't secrets: `AGENT_CHANNEL_ID`, `AGENT_ALLOWLIST`, `SENTRY_ORG`, `SENTRY_PROJECT`, and `GITHUB_REPO`.
2. Copy `agent-vault.env.example` to `agent-vault.env`, and fill in the proxy token, the machine identity's client ID and client secret, the Agent Vault project ID, and the proxy's fingerprint. If you use Infisical outside US Cloud, add `INFISICAL_DOMAIN`, such as `https://eu.infisical.com`.
3. From this folder, start both containers:

   ```
   docker compose --env-file agent-vault.env up --build
   ```

4. Mention the bot in its channel.

The agent's image is built from [`Dockerfile`](../Dockerfile), with the Infisical CLI, Claude Code, `git`, and `gh`. On start, the image runs `infisical agent-vault run`, which opens the session and starts the Slack bridge. Claude Code runs as the `node` user and works in `/home/node/on-call-agent/` inside the container.

To run the same image on another container platform, such as ECS or Render, set the variables from `compose.yaml` on the agent's service. Set `INFISICAL_AGENT_VAULT_PROXY_ADDRESS` to the proxy's address on your private network.
