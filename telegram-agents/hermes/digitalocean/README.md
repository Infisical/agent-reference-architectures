# Hermes on a DigitalOcean Droplet

Runs the Hermes gateway and an Agent Vault proxy as two systemd services on one DigitalOcean Droplet. The proxy listens only on `127.0.0.1`, and the gateway needs no inbound port, because it polls Telegram for messages.

The steps after [Create the Droplet](#create-the-droplet) work on any Ubuntu server, such as a Hetzner server or an EC2 instance.

## What you need

- A DigitalOcean account, and an SSH key added to it
- Steps 1 to 4 of the [Hermes README](../README.md) completed, so the Telegram bot, proxy, access bundle, and machine identity exist
- The proxy token, the machine identity's client ID and client secret, the Agent Vault project ID, and the proxy's fingerprint
- Your Telegram user ID

## Create the Droplet

1. In DigitalOcean, select **Create** > **Droplets**.
2. Choose a region, the **Ubuntu 24.04 (LTS) x64** image, and a **Basic** plan with at least 1 GB of memory.
3. Under **Authentication**, select your SSH key, then select **Create Droplet**.
4. Go to **Networking** > **Firewalls** and select **Create Firewall**. Keep only the SSH rule under **Inbound Rules**, keep the default **Outbound Rules**, apply the firewall to the Droplet, and select **Create Firewall**.
5. Connect to the Droplet with its IP address:

   ```
   ssh root@<droplet-ip>
   ```

## Run it

1. Install the Infisical CLI, `git`, and `libatomic1`, which the Node.js that Hermes installs needs:

   ```
   curl -1sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | sudo bash
   sudo apt-get install -y infisical=0.45.13 git libatomic1
   ```

2. Create a user for Hermes, and install Hermes as that user:

   ```
   sudo useradd --create-home --shell /usr/sbin/nologin hermes
   cd /home/hermes
   curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o /tmp/hermes-install.sh
   sudo -u hermes -H bash /tmp/hermes-install.sh --non-interactive --skip-browser --skip-computer-use
   ```

   The installer puts Hermes in `/home/hermes/.hermes` and the `hermes` command in `/home/hermes/.local/bin`.

3. Set the model, and replace `<your-telegram-user-id>` with your user ID. Only that ID can message Hermes:

   ```
   sudo -u hermes -H /home/hermes/.local/bin/hermes config set model.provider anthropic
   sudo -u hermes -H /home/hermes/.local/bin/hermes config set model.default claude-sonnet-5-5
   sudo -u hermes -H /home/hermes/.local/bin/hermes config set platforms.telegram.extra.allow_from '["<your-telegram-user-id>"]'
   ```

4. Clone this repo, and create the two files that hold secrets, readable only by root:

   ```
   sudo git clone https://github.com/Infisical/agent-reference-architectures.git /opt/agent-reference-architectures
   cd /opt/agent-reference-architectures/telegram-agents/hermes
   sudo mkdir -p /etc/infisical
   echo 'INFISICAL_AGENT_VAULT_PROXY_TOKEN=<proxy-token>' | sudo tee /etc/infisical/agent-vault-proxy.env
   sudo cp digitalocean/hermes.env.example /etc/infisical/hermes.env
   sudo chmod 600 /etc/infisical/*.env
   ```

   Fill in `/etc/infisical/hermes.env` with the machine identity's client ID and client secret, the Agent Vault project ID, and the proxy's fingerprint. If you use Infisical outside US Cloud, add `INFISICAL_DOMAIN` to both files.

   If `nano` or `vim` fails with `Error opening terminal`, the Droplet doesn't know your terminal emulator. Run `export TERM=xterm-256color` and try again.

5. Install and start the services:

   ```
   sudo cp digitalocean/agent-vault-proxy.service digitalocean/hermes-gateway.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now agent-vault-proxy hermes-gateway
   ```

6. Check the gateway's log, then message your bot on Telegram:

   ```
   journalctl -u hermes-gateway -f
   ```

   The log shows `Connected to Telegram (polling mode)` when the gateway is ready.

The gateway runs as the `hermes` user, which can't open the secret files. systemd passes Hermes's client secret to its processes as an environment variable, so Hermes can read it. That's by design, as [Agent Vault configuration](../README.md#agent-vault-configuration) explains. The proxy runs as root, so Hermes can't read the proxy token.

Hermes keeps its config, memory, and sessions in `/home/hermes/.hermes/`, and runs commands with the `hermes` user's permissions. Give the Droplet to Hermes alone.

To run a `hermes` command, such as `hermes update`, run it as the `hermes` user, then restart the gateway:

```
sudo -u hermes -H /home/hermes/.local/bin/hermes update
sudo systemctl restart hermes-gateway
```

`hermes-gateway.service` replaces the unit that `hermes gateway install` creates, because that unit can't start the gateway inside `infisical agent-vault run`. Don't install both.
