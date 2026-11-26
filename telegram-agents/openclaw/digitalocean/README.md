# OpenClaw on a DigitalOcean Droplet

Runs the OpenClaw gateway and an Agent Vault proxy as two systemd services on one DigitalOcean Droplet. The proxy listens only on `127.0.0.1`, and the gateway needs no inbound port, because it polls Telegram for messages.

The steps after [Create the Droplet](#create-the-droplet) work on any Ubuntu server, such as a Hetzner server or an EC2 instance.

## What you need

- A DigitalOcean account, and an SSH key added to it
- Steps 1 to 4 of the [OpenClaw README](../README.md) completed, so the Telegram bot, proxy, access bundle, and machine identity exist
- The proxy token, the machine identity's client ID and client secret, the Agent Vault project ID, and the proxy's fingerprint
- Your Telegram user ID

## Create the Droplet

1. In DigitalOcean, select **Create** > **Droplets**.
2. Choose a region, the **Ubuntu 24.04 (LTS) x64** image, and a **Basic** plan with 2 GB of memory. A 1 GB plan works with a swap file, but OpenClaw responds slowly.
3. Under **Authentication**, select your SSH key, then select **Create Droplet**.
4. Go to **Networking** > **Firewalls** and select **Create Firewall**. Keep only the SSH rule under **Inbound Rules**, keep the default **Outbound Rules**, apply the firewall to the Droplet, and select **Create Firewall**.
5. Connect to the Droplet with its IP address:

   ```
   ssh root@<droplet-ip>
   ```

## Run it

1. If the Droplet has less than 2 GB of memory, add a 2 GB swap file. The gateway uses about 600 MB, and stalls without swap on a 1 GB Droplet:

   ```
   sudo fallocate -l 2G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```

2. Install Node.js 24, the Infisical CLI, `git`, and OpenClaw:

   ```
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
   curl -1sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | sudo bash
   sudo apt-get install -y nodejs infisical=0.45.13 git
   sudo npm install -g --allow-scripts=openclaw openclaw@2026.11.10
   ```

3. Create a user for OpenClaw, clone this repo, and copy the config into the user's home:

   ```
   sudo useradd --create-home --shell /usr/sbin/nologin openclaw
   sudo git clone https://github.com/Infisical/agent-reference-architectures.git /opt/agent-reference-architectures
   cd /opt/agent-reference-architectures/telegram-agents/openclaw
   sudo install -d -o openclaw -g openclaw -m 700 /home/openclaw/.openclaw
   sudo install -o openclaw -g openclaw -m 600 openclaw.json /home/openclaw/.openclaw/openclaw.json
   ```

   Edit `/home/openclaw/.openclaw/openclaw.json`, and replace `<your-telegram-user-id>` with your user ID.

   If `nano` or `vim` fails with `Error opening terminal`, the Droplet doesn't know your terminal emulator. Run `export TERM=xterm-256color` and try again.

4. Create the two files that hold secrets, readable only by root:

   ```
   sudo mkdir -p /etc/infisical
   echo 'INFISICAL_AGENT_VAULT_PROXY_TOKEN=<proxy-token>' | sudo tee /etc/infisical/agent-vault-proxy.env
   sudo cp digitalocean/openclaw.env.example /etc/infisical/openclaw.env
   sudo chmod 600 /etc/infisical/*.env
   ```

   Fill in `/etc/infisical/openclaw.env` with the machine identity's client ID and client secret, the Agent Vault project ID, and the proxy's fingerprint. If you use Infisical outside US Cloud, add `INFISICAL_DOMAIN` to both files.

5. Install and start the services:

   ```
   sudo cp digitalocean/agent-vault-proxy.service digitalocean/openclaw-gateway.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now agent-vault-proxy openclaw-gateway
   ```

6. Check the gateway's log, then message your bot on Telegram:

   ```
   journalctl -u openclaw-gateway -f
   ```

The gateway runs as the `openclaw` user, which can't open the secret files. systemd passes OpenClaw's client secret to its processes as an environment variable, so OpenClaw can read it. That's by design, as [Agent Vault configuration](../README.md#agent-vault-configuration) explains. The proxy runs as root, so OpenClaw can't read the proxy token.

OpenClaw keeps its memory and sessions in `/home/openclaw/.openclaw/`, and runs commands with the `openclaw` user's permissions. Give the Droplet to OpenClaw alone.

To run an `openclaw` command against the gateway, such as `openclaw channels status`, run it as the `openclaw` user:

```
sudo -u openclaw -H openclaw channels status --probe
```

`openclaw-gateway.service` replaces the unit that `openclaw gateway install` creates, because that unit can't start the gateway inside `infisical agent-vault run`. Don't install both.
