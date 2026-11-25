# Coding agent

A Slack agent that works on your code. Mention it in a channel, and it answers questions about the repo, or makes the change you ask for on a branch and opens a pull request.

The agent is Claude Code, running in a clone of your repo with a shell. It holds no real API keys. [Infisical Agent Vault](https://infisical.com/docs/documentation/platform/agent-vault/overview) attaches each credential to the agent's requests on their way out, and blocks requests to any host outside the agent's access bundle.

## How it works

```mermaid
flowchart LR
  slack[Slack]
  subgraph box[The agent's machine]
    bridge["Slack bridge"]
    claude["Claude Code<br/>in a clone of the repo"]
  end
  proxy[Agent Vault proxy]
  vault["Infisical Agent Vault<br/>identity, access bundle,<br/>credentials, session logs"]
  apis["Slack, Anthropic,<br/>GitHub"]

  slack -- "@mention" --> bridge
  bridge -- "claude -p" --> claude
  bridge & claude -- "all HTTPS" --> proxy
  proxy -- "real credential attached" --> apis
  bridge -. "log in, open session" .-> vault
  proxy -. "check session, fetch credential" .-> vault
```

1. `infisical agent-vault run` logs in as the agent's machine identity, opens a [session](https://infisical.com/docs/documentation/platform/agent-vault/sessions) on the `coding` [access bundle](https://infisical.com/docs/documentation/platform/agent-vault/access-bundles), and starts the Slack bridge behind the Agent Vault [proxy](https://infisical.com/docs/documentation/platform/agent-vault/proxies).
2. When someone mentions the bot, the bridge runs `claude -p` with the message. Claude Code inherits the proxy settings, so all of its HTTPS traffic goes through the proxy, including `git` and `gh`.
3. If the host is in the access bundle, the proxy attaches the real credential. If it isn't, the proxy returns a 403.
4. The bridge posts what Claude Code is doing as a status line in Slack, then posts its answer in the thread.

The code in this repo never calls Infisical, and holds no keys. The agent's environment has only placeholders, such as `SLACK_BOT_TOKEN=xoxb-avplaceholder-coding-bot` and `GH_TOKEN=placeholder`. Claude Code, `gh`, and the Slack SDK each refuse to start without a token, so they get a placeholder, which the proxy replaces.

## What's in this folder

| File | What it does |
| --- | --- |
| `prompt.md` | The agent's instructions, added to Claude Code's system prompt |
| `.env.example` | The agent's settings |
| `slack-app-manifest.yaml` | The Slack app |
| `src/` | The Slack bridge: reads Slack and runs `claude -p` for each message |
| `vm/` | The deployment |

Claude Code works in `~/coding-agent`, where it keeps its clone of the repo between messages. It runs in `bypassPermissions` mode, so it can run any command without asking. The machine it runs on is the boundary. Run it on a machine of its own, such as the [VM](vm) deployment.

## Agent Vault configuration

**Access bundle:** `coding`, with these services:

| Service | Template | Hosts | Credential |
| --- | --- | --- | --- |
| Anthropic | Anthropic | `api.anthropic.com` | An Anthropic API key |
| GitHub | GitHub | The template's hosts, which include `github.com` for `git` | A fine-grained personal access token for the repo |
| Slack | Slack | `slack.com, *.slack.com` | Pass-through, with two header [substitutions](https://infisical.com/docs/documentation/platform/agent-vault/services#substitutions) for the bot token and the app-level token |

**Machine identity:** `coding-agent`, with the Member role in Agent Vault and access to the `coding` access bundle only.

**Proxy:** one proxy with the **Service hosts only** traffic policy, and the package registries the repo's tests need in **Exceptions**.

The machine identity's client secret is on the agent's machine, so the agent can read it and open more sessions. That's by design. A Member can only open sessions on the access bundles it's granted, so a session the agent opens for itself reaches nothing the first one didn't. Two consequences:

- Grant the identity this one access bundle only, and keep its role at Member
- Revoking the agent's session doesn't stop it, because it can open another one. To stop the agent, revoke the client secret

To limit where a leaked client secret works, restrict it to the agent's machine with [trusted IPs](https://infisical.com/docs/documentation/platform/identities/universal-auth), and give it an expiry.

## What you need

**Accounts and tools:**

- An Infisical organization with Agent Vault, and the Admin role in an Agent Vault project
- A Slack workspace where you can create apps
- A GitHub repo with at least one commit
- The [Infisical CLI](https://infisical.com/docs/cli/overview), version 0.45.13 or later. If Homebrew can't upgrade it, `npx @infisical/cli@0.45.13` runs the same CLI
- Node.js 24 or later, [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), and the [GitHub CLI](https://cli.github.com), to run the agent locally

**Credentials.** Each one goes into Agent Vault, never into a file or the agent's environment:

| Credential | Where to get it | Where it goes |
| --- | --- | --- |
| Anthropic API key | The Anthropic Console | The Anthropic service |
| GitHub fine-grained personal access token for the repo, with Contents and Pull requests read and write | GitHub's **Settings** > **Developer settings** > **Personal access tokens** > **Fine-grained tokens** | The GitHub service |
| Slack bot token (`xoxb-...`) and app-level token (`xapp-...`) | The Slack app, in [Step 1](#step-1-create-the-slack-app) | The Slack service's substitutions |

To keep the agent off the default branch on GitHub's side too, protect the default branch with a rule that requires a pull request.

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
| `GITHUB_REPO` | The repo, as `owner/repo` |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | The name and email the agent's commits show. GitHub links a commit to an account only if its email is verified on that account, so use one of the token owner's emails, such as the `noreply` address from GitHub's email settings |

You also need the Agent Vault project's ID and the proxy's fingerprint, which aren't secret either. The deployment's secret file holds them, next to the secrets.

## Step 1: Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and select **Create New App** > **From a manifest**.
2. Paste [`slack-app-manifest.yaml`](slack-app-manifest.yaml) and select **Create**.
3. Install the app to your workspace, then copy the **Bot User OAuth Token** (`xoxb-...`) from **OAuth & Permissions**.
4. In **Basic Information** > **App-Level Tokens**, create a token with the `connections:write` scope and copy it (`xapp-...`).
5. Invite the bot to the channel where it should answer, and copy the channel ID from the channel's details.

The app uses Socket Mode, so the agent doesn't need a public URL.

## Step 2: Create the proxy

1. In Agent Vault, go to **Proxies** and select **Create Proxy**.
2. Enter a **Name**, expand **Advanced Options**, and set **Traffic Policy** to **Service hosts only**. With **Any host**, the proxy forwards requests to hosts outside the access bundle instead of blocking them.
3. Add the package registries the repo's tests install from to **Exceptions**, such as `registry.npmjs.org` or `pypi.org` and `files.pythonhosted.org`. The proxy lets them through without a credential.
4. Select **Create**. The **Proxy Token** dialog shows the proxy token, with commands to run the proxy with the CLI, systemd, Docker, or Kubernetes.
5. Keep the proxy token. You can rotate it later from the proxy's menu. Rotating it also changes the proxy's fingerprint, so update the fingerprint wherever the agent runs.
6. Copy the proxy's fingerprint from the **Certificate Authority** column on the **Proxies** page. The agent uses it to check that it's talking to your proxy.

The [VM](vm) deployment runs the proxy for you. To run it on your own machine for [Step 5](#step-5-run-the-agent-locally):

```
INFISICAL_AGENT_VAULT_PROXY_TOKEN=<proxy-token> infisical agent-vault proxy --data-dir ~/.infisical/agent-vault-coding
```

The proxy listens on port 17323. Use a `--data-dir` of its own if you've run another Agent Vault proxy on the same machine.

## Step 3: Create the access bundle

1. Go to **Access Bundles** and select **Create Access Bundle**. Name it `coding`.
2. Open the access bundle and select **Add Service**. Add the Anthropic and GitHub services from their templates, and paste each credential.

The Slack app sends two tokens to Slack. The bot token goes on API calls, and the app-level token opens the Socket Mode connection. A single credential would send the bot token on both, so the Slack service uses substitutions:

1. Add a service from the **Slack** template.
2. On the **Details** step, add `*.slack.com` to **Hosts**. The Socket Mode connection uses a subdomain of `slack.com`.
3. On the **Credential** step, set the credential type to **Pass-through**.
4. Expand **Advanced Options** and select **Add Substitution**. Enter `xoxb-avplaceholder-coding-bot` in **Replace**, enter the bot token in **With**, and keep **Headers** selected under **Replace In**.
5. Add a second substitution that replaces `xapp-avplaceholder-coding-app` with the app-level token.

## Step 4: Create the machine identity

1. Create a [machine identity](https://infisical.com/docs/documentation/platform/identities/machine-identities) named `coding-agent` with Universal Auth, and create a client secret for it.
2. In Agent Vault, go to **Access Control** > **Machine Identities** and select **Add Machine Identity**. Select the identity and choose **Member** in **Product Role**.
3. Open the `coding` access bundle, select **Manage Access**, and select **Grant Access** next to the identity.

Keep the client ID and client secret. The client secret is the only real secret the agent's machine holds.

## Step 5: Run the agent locally

Run it locally to test it. For anything longer, deploy it, so the agent's shell runs on a machine of its own.

1. From this folder, install the dependencies and check the types:

   ```
   npm install
   npm run typecheck
   ```

2. Copy `.env.example` to `.env`, and fill in the settings from [What you need](#what-you-need). Leave the placeholders as they are.

3. With the proxy from Step 2 running, log in as the machine identity and ask the agent one question without Slack:

   ```
   export INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=<client-id>
   export INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=<client-secret>
   export INFISICAL_AGENT_VAULT_PROJECT_ID=<agent-vault-project-id>
   infisical agent-vault run --access-bundle coding --proxy localhost:17323 \
     --ca-fingerprint <fingerprint> \
     -- npm run ask -- "What does this repo do, and how are its tests run?"
   ```

   If you use Infisical outside US Cloud, also set `INFISICAL_DOMAIN`, such as `https://eu.infisical.com`.

4. Replace `npm run ask -- "..."` with `npm start` to start the Slack bot, then mention the bot in its channel.

Claude Code works in `~/coding-agent`. On your own machine, it also loads your `~/.claude` settings. The session ends when the agent exits.

## Step 6: Deploy

- [Virtual machine](vm): the agent and the proxy as systemd services on a Linux VM

## Limits

- The agent handles one message at a time, because each run uses the same working folder. A long change holds up everyone else's messages until it finishes or times out after 20 minutes
- Everyone who can use the agent shares its access and its session. The bot checks the allowlist and channel itself, and Agent Vault doesn't know who in Slack asked
- With a shell, the agent can send requests that skip the proxy. It gets no credentials that way, but it can reach hosts outside the access bundle. The VM deployment doesn't block that yet
- Claude Code loads `CLAUDE.md` and `.claude/` settings from the cloned repo, and runs the repo's tests. Point the agent only at a repo whose contents you trust
