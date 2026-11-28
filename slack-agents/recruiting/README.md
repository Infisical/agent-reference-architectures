# Recruiting agent

A Slack agent for your hiring team. Mention it in a channel, and it answers questions about open jobs, candidates, and where each one is in the pipeline, from Ashby.

The agent is Claude Code with a shell, and it reads Ashby through Ashby's MCP server. It holds no real API keys. [Infisical Agent Vault](https://infisical.com/docs/documentation/platform/agent-vault/overview) attaches each credential to the agent's requests on their way out, and blocks requests to any host outside the agent's access bundle.

## How it works

```mermaid
flowchart LR
  slack[Slack]
  subgraph box[The agent's machine]
    bridge["Slack bridge"]
    claude["Claude Code<br/>with a shell"]
  end
  proxy[Agent Vault proxy]
  vault["Infisical Agent Vault<br/>identity, access bundle,<br/>credentials, session logs"]
  apis["Slack, Anthropic,<br/>Ashby MCP"]

  slack -- "@mention" --> bridge
  bridge -- "claude -p" --> claude
  bridge & claude -- "all HTTPS" --> proxy
  proxy -- "real credential attached" --> apis
  bridge -. "log in, open session" .-> vault
  proxy -. "check session, fetch credential" .-> vault
```

1. `infisical agent-vault run` logs in as the agent's machine identity, opens a [session](https://infisical.com/docs/documentation/platform/agent-vault/sessions) on the `recruiting` [access bundle](https://infisical.com/docs/documentation/platform/agent-vault/access-bundles), and starts the Slack bridge behind the Agent Vault [proxy](https://infisical.com/docs/documentation/platform/agent-vault/proxies).
2. When someone mentions the bot, the bridge runs `claude -p` with the message. Claude Code inherits the proxy settings, so all of its HTTPS traffic goes through the proxy. It connects to Ashby's MCP server from [`mcp.json`](mcp.json).
3. The proxy attaches the Ashby access token to each MCP request, hides the Ashby tools the service doesn't allow from Claude Code, and refuses calls to them.
4. The bridge posts what Claude Code is doing as a status line in Slack, then posts its answer in the thread.

The code in this repo never calls Infisical, and holds no keys. The agent's environment has only placeholders, such as `SLACK_BOT_TOKEN=xoxb-avplaceholder-recruiting-bot`. Claude Code and the Slack SDK each refuse to start without a token, so they get a placeholder, which the proxy replaces.

## What's in this folder

| File | What it does |
| --- | --- |
| `prompt.md` | The agent's instructions, added to Claude Code's system prompt |
| `mcp.json` | Ashby's MCP server, by its URL and with no credential |
| `.env.example` | The agent's settings |
| `slack-app-manifest.yaml` | The Slack app |
| `src/` | The Slack bridge: reads Slack and runs `claude -p` for each message |
| `Dockerfile`, `docker/` | The Docker deployment: the agent's image, and a Compose file that runs it next to the proxy |
| `vm/` | The VM deployment: systemd services for the agent and the proxy, and the template for the agent's secret file |

To give the agent another MCP server, such as your calendar, add its service to the access bundle and list the server in `mcp.json`.

## Agent Vault configuration

**Access bundle:** `recruiting`, with these services:

| Service | Template | Hosts or server | Credential |
| --- | --- | --- | --- |
| Anthropic | Anthropic | `api.anthropic.com` | An Anthropic API key |
| Ashby | Ashby MCP | `https://mcp.ashbyhq.com/mcp/v1` | OAuth, with the read tools only in **Allowed Tools** |
| Slack | Slack | `slack.com, *.slack.com` | Pass-through, with two header [substitutions](https://infisical.com/docs/documentation/platform/agent-vault/services#substitutions) for the bot token and the app-level token |

**Machine identity:** `recruiting-agent`, with the Member role in Agent Vault and access to the `recruiting` access bundle only.

**Proxy:** one proxy with the **Service hosts only** traffic policy.

The Ashby service acts as the Ashby account you authorize it with, so the agent can see everything that account can. Authorize it with an account whose access matches what the hiring team in the channel may see.

The machine identity's client secret is on the agent's machine, so the agent can read it and open more sessions. That's by design. A Member can only open sessions on the access bundles it's granted, so a session the agent opens for itself reaches nothing the first one didn't. Two consequences:

- Grant the identity this one access bundle only, and keep its role at Member
- Revoking the agent's session doesn't stop it, because it can open another one. To stop the agent, revoke the client secret

To limit where a leaked client secret works, restrict it to the agent's machine with [trusted IPs](https://infisical.com/docs/documentation/platform/identities/universal-auth), and give it an expiry.

## What you need

**Accounts and tools:**

- An Infisical organization with Agent Vault, and the Admin role in an Agent Vault project
- A Slack workspace where you can create apps
- An Ashby account that can sign in to Ashby's MCP server
- Somewhere to deploy the agent: Docker with Compose, or a Debian or Ubuntu VM with outbound internet access and `sudo`, such as an EC2 instance or a DigitalOcean Droplet

**Credentials.** Each one goes into Agent Vault, never into a file or the agent's environment:

| Credential | Where to get it | Where it goes |
| --- | --- | --- |
| Anthropic API key | The Anthropic Console | The Anthropic service |
| Ashby access | Your Ashby sign-in, in [Step 3](#step-3-create-the-access-bundle) | The Ashby service |
| Slack bot token (`xoxb-...`) and app-level token (`xapp-...`) | The Slack app, in [Step 1](#step-1-create-the-slack-app) | The Slack service's substitutions |

**Secrets for running the agent.** Each one goes into the deployment's secret file, never into git:

| Secret | Where to get it |
| --- | --- |
| Proxy token | The **Proxy Token** dialog, in [Step 2](#step-2-create-the-proxy) |
| Machine identity client ID and client secret | The machine identity, in [Step 4](#step-4-create-the-machine-identity) |

**Settings that aren't secret.** They go into `.env`:

| Setting | Where to get it |
| --- | --- |
| `AGENT_CHANNEL_ID` | The Slack channel's details |
| `AGENT_ALLOWLIST` | The emails on the Slack profiles of the people who can use the agent |

You also need the Agent Vault project's ID and the proxy's fingerprint, which aren't secret either. The agent's secret file holds them, next to the secrets.

## Step 1: Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and select **Create New App** > **From a manifest**.
2. Paste [`slack-app-manifest.yaml`](slack-app-manifest.yaml) and select **Create**.
3. Install the app to your workspace, then copy the **Bot User OAuth Token** (`xoxb-...`) from **OAuth & Permissions**.
4. In **Basic Information** > **App-Level Tokens**, create a token with the `connections:write` scope and copy it (`xapp-...`).
5. Invite the bot to the channel where it should answer, and copy the channel ID from the channel's details. Use a private channel for the hiring team, because everyone in the channel can read the agent's answers about candidates.

The app uses Socket Mode, so the agent doesn't need a public URL.

## Step 2: Create the proxy

1. In Agent Vault, go to **Proxies** and select **Create Proxy**.
2. Enter a **Name**, expand **Advanced Options**, and set **Traffic Policy** to **Service hosts only**. With **Any host**, the proxy forwards requests to hosts outside the access bundle instead of blocking them.
3. Select **Create**, and keep the proxy token from the **Proxy Token** dialog. You can rotate it later from the proxy's menu. Rotating it also changes the proxy's fingerprint, so update the fingerprint wherever the agent runs.
4. Copy the proxy's fingerprint from the **Certificate Authority** column on the **Proxies** page. The agent uses it to check that it's talking to your proxy.

## Step 3: Create the access bundle

1. Go to **Access Bundles** and select **Create Access Bundle**. Name it `recruiting`.
2. Open the access bundle and select **Add Service**. Add the Anthropic service from its template, and paste the API key.

Add Ashby's MCP server:

1. Add a service from the **Ashby MCP** template.
2. On the **Credential** step, keep **OAuth** as the credential type, select **Authorize**, and sign in to Ashby. If Ashby doesn't let Infisical register as an OAuth client, [use your own OAuth app](https://infisical.com/docs/documentation/platform/agent-vault/mcp-servers#use-your-own-oauth-app).
3. On the **Tools** step, turn off **All Tools**. In **Allowed Tools**, select only the tools that read data, such as the ones that search candidates and list jobs. The proxy hides every other tool from the agent and refuses calls to them, so the agent can't change anything in Ashby.

The Slack app sends two tokens to Slack. The bot token goes on API calls, and the app-level token opens the Socket Mode connection. A single credential would send the bot token on both, so the Slack service uses substitutions:

1. Add a service from the **Slack** template.
2. On the **Details** step, add `*.slack.com` to **Hosts**. The Socket Mode connection uses a subdomain of `slack.com`.
3. On the **Credential** step, set the credential type to **Pass-through**.
4. Expand **Advanced Options** and select **Add Substitution**. Enter `xoxb-avplaceholder-recruiting-bot` in **Replace**, enter the bot token in **With**, and keep **Headers** selected under **Replace In**.
5. Add a second substitution that replaces `xapp-avplaceholder-recruiting-app` with the app-level token.

## Step 4: Create the machine identity

1. Create a [machine identity](https://infisical.com/docs/documentation/platform/identities/machine-identities) named `recruiting-agent` with Universal Auth, and create a client secret for it.
2. In Agent Vault, go to **Access Control** > **Machine Identities** and select **Add Machine Identity**. Select the identity and choose **Member** in **Product Role**.
3. Open the `recruiting` access bundle, select **Manage Access**, and select **Grant Access** next to the identity.

Keep the client ID and client secret. The client secret is the only real secret the agent's machine holds.

## Step 5: Deploy the agent

Deploy the agent with Docker or on a VM. Either way, the agent and the proxy run side by side, and the agent needs no inbound port, because Socket Mode connects out to Slack.

### With Docker

1. In this folder, copy `.env.example` to `.env`, and fill in the settings from [What you need](#what-you-need). Leave the placeholders as they are.

2. Copy the template for the secret file, and keep the copy out of git:

   ```
   cp docker/agent-vault.env.example docker/agent-vault.env
   ```

3. Fill in `docker/agent-vault.env` with the proxy token, the machine identity's client ID and client secret, the Agent Vault project ID, and the proxy's fingerprint. If you use Infisical outside US Cloud, add `INFISICAL_DOMAIN`, such as `https://eu.infisical.com`.

4. Start the proxy and the agent:

   ```
   cd docker
   docker compose --env-file agent-vault.env up --build
   ```

5. Mention the bot in its channel, and ask it which jobs are open.

To run the same image on another container platform, such as ECS or Render, set the variables from `docker/compose.yaml` on the agent's service. Set `INFISICAL_AGENT_VAULT_PROXY_ADDRESS` to the proxy's address on your private network.

### On a VM

The agent and the proxy run as two systemd services.

1. Connect to the VM, and install Node.js 24, the Infisical CLI, `git`, and Claude Code:

   ```
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
   curl -1sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | sudo bash
   sudo apt-get install -y nodejs infisical=0.45.13 git
   sudo npm install -g @anthropic-ai/claude-code@2.1.330
   ```

2. Create a user for the agent, and clone this repo:

   ```
   sudo useradd --create-home --shell /usr/sbin/nologin agent
   sudo git clone https://github.com/Infisical/agent-reference-architectures.git /opt/agent-reference-architectures
   cd /opt/agent-reference-architectures/slack-agents/recruiting
   sudo npm ci --omit=dev
   ```

3. Copy `.env.example` to `.env`, and fill in the settings from [What you need](#what-you-need). Leave the placeholders as they are:

   ```
   sudo cp .env.example .env
   ```

4. Create the two files that hold secrets, readable only by root. Replace `<proxy-token>` with the proxy token from [Step 2](#step-2-create-the-proxy):

   ```
   sudo mkdir -p /etc/infisical
   echo 'INFISICAL_AGENT_VAULT_PROXY_TOKEN=<proxy-token>' | sudo tee /etc/infisical/agent-vault-proxy.env
   sudo cp vm/recruiting-agent.env.example /etc/infisical/recruiting-agent.env
   sudo chmod 600 /etc/infisical/*.env
   ```

5. Fill in `/etc/infisical/recruiting-agent.env` with the machine identity's client ID and client secret, the Agent Vault project ID, and the proxy's fingerprint. If you use Infisical outside US Cloud, add `INFISICAL_DOMAIN` to both files.

   If `nano` or `vim` fails with `Error opening terminal`, the VM doesn't know your terminal emulator. Run `export TERM=xterm-256color` and try again.

6. Install and start the proxy and the agent:

   ```
   sudo cp vm/agent-vault-proxy.service vm/recruiting-agent.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now agent-vault-proxy recruiting-agent
   ```

7. Check the agent's log, then mention the bot in its channel, and ask it which jobs are open:

   ```
   journalctl -u recruiting-agent -f
   ```

The agent runs as the `agent` user, which can't open the secret files. The proxy runs as root, so the agent can't read the proxy token.

## Limits

- The agent handles one message at a time, so a long question holds up the next one until it finishes or times out after 20 minutes
- Everyone who can use the agent shares its access and its session, and sees what the Ashby account it uses can see. The bot checks the allowlist and channel itself, and Agent Vault doesn't know who in Slack asked
- The agent has no memory between threads. Within a thread, it reads the earlier messages each time it's mentioned
- With a shell, the agent can send requests that skip the proxy. It gets no credentials that way, but it can reach hosts outside the access bundle. The Docker and VM deployments don't block that yet
