# On-call agent on a virtual machine

Runs the on-call agent and an Agent Vault proxy as two systemd services on one Linux VM, such as an EC2 instance or a Droplet. The proxy listens only on `127.0.0.1`.

## What you need

- A Debian or Ubuntu VM with outbound internet access and `sudo`
- Steps 1 to 4 of the [on-call agent's README](../README.md) completed, so the Slack app, proxy, access bundle, and machine identity exist
- The proxy token, the machine identity's client ID and client secret, the Agent Vault project ID, and the proxy's fingerprint
- The settings for `.env`, listed in [What you need](../README.md#what-you-need)

## Run it

1. Install Node.js 24, the Infisical CLI, `git`, the GitHub CLI, and Claude Code:

   ```
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
   curl -1sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | sudo bash
   sudo curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list
   sudo apt-get update
   sudo apt-get install -y nodejs infisical=0.45.13 git gh
   sudo npm install -g @anthropic-ai/claude-code@2.1.330
   ```

2. Create a user for the agent, and clone this repo:

   ```
   sudo useradd --create-home --shell /usr/sbin/nologin agent
   sudo git clone https://github.com/Infisical/agent-reference-architectures.git /opt/agent-reference-architectures
   cd /opt/agent-reference-architectures/slack-agents/on-call
   sudo npm ci --omit=dev
   ```

   The repo stays owned by root, so the agent can't change the bridge or its own prompt.

3. Copy `.env.example` to `.env`, and fill in the values that aren't secrets: `AGENT_CHANNEL_ID`, `AGENT_ALLOWLIST`, `SENTRY_ORG`, `SENTRY_PROJECT`, `GITHUB_REPO`, and the `GIT_AUTHOR_*` and `GIT_COMMITTER_*` name and email.

4. Create the two files that hold secrets, readable only by root:

   ```
   sudo mkdir -p /etc/infisical
   echo 'INFISICAL_AGENT_VAULT_PROXY_TOKEN=<proxy-token>' | sudo tee /etc/infisical/agent-vault-proxy.env
   sudo cp vm/on-call-agent.env.example /etc/infisical/on-call-agent.env
   sudo chmod 600 /etc/infisical/*.env
   ```

   Fill in `/etc/infisical/on-call-agent.env` with the machine identity's client ID and client secret, the Agent Vault project ID, and the proxy's fingerprint. If you use Infisical outside US Cloud, add `INFISICAL_DOMAIN` to both files.

   If `nano` or `vim` fails with `Error opening terminal`, the VM doesn't know your terminal emulator. Run `export TERM=xterm-256color` and try again.

5. Install and start the services:

   ```
   sudo cp vm/agent-vault-proxy.service vm/on-call-agent.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now agent-vault-proxy on-call-agent
   ```

6. Check the agent's log, then mention the bot in its channel:

   ```
   journalctl -u on-call-agent -f
   ```

The agent runs as the `agent` user, which can't open the secret files. systemd passes the agent's client secret to its processes as an environment variable, so the agent can read it. That's by design, as [Agent Vault configuration](../README.md#agent-vault-configuration) explains. The proxy runs as root, so the agent can't read the proxy token.

Claude Code works in `/home/agent/on-call-agent/`, and runs commands with the `agent` user's permissions. Give the VM to the agent alone.
