# Slack agents with Agent Vault

This repo contains two Slack agents built on the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview). Neither agent holds a real API key. [Infisical Agent Vault](https://infisical.com/docs/documentation/platform/agent-vault/overview) attaches each credential to the agent's requests on their way out, and blocks requests to any API the agent isn't allowed to use.

- **Jimmy** is an on-call engineer. He reads errors in Sentry, traces them to a commit on GitHub, and files issues
- **Penny** runs growth. She reads payments in Stripe, creates coupons, and drafts customer emails

This is the simplest version of the setup: one long-running container per agent, with custom tools and no sandbox. Use it as a starting point for your own agents.

## How it works

```mermaid
flowchart LR
  slack[Slack]
  subgraph render[Render]
    jimmy["Jimmy<br/>placeholders only"]
    penny["Penny<br/>placeholders only"]
    proxy[Agent Vault proxy]
  end
  vault["Infisical Agent Vault<br/>identities, access bundles,<br/>credentials, session logs"]
  apis["slack.com, api.anthropic.com,<br/>sentry.io, api.github.com,<br/>api.stripe.com"]

  slack -- "@mention" --> jimmy & penny
  jimmy & penny -- "all HTTPS" --> proxy
  proxy -- "real credential attached" --> apis
  jimmy & penny -. "log in, open session" .-> vault
  proxy -. "check session, fetch credential" .-> vault
```

1. Someone @mentions an agent in Slack.
2. The agent runs in a container on Render. The container's environment holds only placeholders, like `SLACK_BOT_TOKEN=xoxb-avplaceholder-jimmy-bot` and `ANTHROPIC_API_KEY=placeholder`.
3. When the container starts, `infisical agent-vault run` logs in as the agent's machine identity and opens a [session](https://infisical.com/docs/documentation/platform/agent-vault/sessions) agents the agent's [access bundle](https://infisical.com/docs/documentation/platform/agent-vault/access-bundles). From then on, all of the agent's HTTPS traffic goes through the Agent Vault [proxy](https://infisical.com/docs/documentation/platform/agent-vault/proxies).
4. If the request's host is in the agent's access bundle, the proxy attaches the real credential. If it isn't, the proxy returns a 403.
5. Agent Vault logs every request, allowed or blocked, against the agent's session.

If someone prompt-injects Jimmy into printing his environment, there's no real key in it to print. If someone asks Jimmy to call Stripe, the proxy blocks the request, because Stripe isn't in Jimmy's access bundle.

## What's in the repo

```
src/
  main.ts                 starts the agent named in AGENT as a Slack bot
  ask.ts                  asks an agent one question from the terminal
  core/                   code every agent shares
    slack.ts              Socket Mode bot: mentions, allowlist, thread context, replies
    run-agent.ts          runs one Agent SDK turn, with the SDK's built-in tools turned off
    agent.ts              the Agent interface and the prompt rules every agent shares
    http-get.ts           read-only GET to any URL; the proxy decides which hosts it reaches
    access.ts             email allowlist
    tool-syntax-guard.ts  catches answers where the model faked a tool call
    chunk-text.ts         splits long answers into several Slack messages
  agents/
    jimmy/                prompt, SOUL.md, Sentry and GitHub tools
    penny/                prompt, SOUL.md, Stripe tools
Dockerfile                one image for every agent; AGENT picks which one runs
docs/
  slack-app-manifest.yaml
```

Each agent is a name, a system prompt, its tools, and the status lines it shows in Slack while a tool runs. Everything else is in `core/`.

| Agent | Tools | Writes |
| --- | --- | --- |
| Jimmy | `list_sentry_issues`, `get_sentry_issue`, `list_recent_commits`, `get_commit`, `read_file`, `file_incident_issue`, `http_get` | Files GitHub issues |
| Penny | `payment_report`, `create_coupon`, `http_get` | Creates Stripe coupons |

The Sentry org, Sentry project, and GitHub repo come from environment variables, so the model can't point the tools anywhere else. The Agent SDK's built-in tools, such as bash and file read and write, are turned off.

## Agent Vault configuration

This is the Agent Vault setup the agents expect. [Step 3](#step-3-create-the-access-bundles) and [Step 4](#step-4-create-a-machine-identity-for-each-agent) walk through creating it.

**Access bundles:**

| Access bundle | Agent | Services |
| --- | --- | --- |
| `on-call-infra` | Jimmy | Anthropic, Sentry, GitHub, Jimmy's Slack |
| `growth-revenue` | Penny | Anthropic, Stripe, Penny's Slack |

**Services:**

| Service | Host | Credential type | Credential |
| --- | --- | --- | --- |
| Anthropic | `api.anthropic.com` | Anthropic template | An Anthropic API key |
| Sentry | `sentry.io` | Bearer | A Sentry internal integration token with read access to projects, issues, and events |
| GitHub | `api.github.com` | GitHub template | A fine-grained personal access token for one repo, with Contents read and Issues read and write |
| Stripe | `api.stripe.com` | Bearer | A Stripe restricted key that can read customers and payment intents, and write coupons |
| Slack | `slack.com, *.slack.com` | Pass-through, with two header [substitutions](https://infisical.com/docs/documentation/platform/agent-vault/services#substitutions) | The agent's bot token (`xoxb-...`) and app-level token (`xapp-...`) |

**Machine identities:**

| Machine identity | Agent Vault role | Granted access bundle |
| --- | --- | --- |
| `jimmy` | Member | `on-call-infra` |
| `penny` | Member | `growth-revenue` |

Each identity has the Member role, so it can only open sessions on the access bundle it's granted. An Admin can open a session on any access bundle.

## Prerequisites

- An Infisical organization with Agent Vault, and the Admin role in Agent Vault
- The [Infisical CLI](https://infisical.com/docs/cli/overview), version 0.43.133 or later
- Node.js 24 or later
- A Slack workspace where you can create apps
- An Anthropic API key, plus the Sentry, GitHub, and Stripe credentials listed in [Agent Vault configuration](#agent-vault-configuration)

## Step 1: Create a Slack app for each agent

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and select **Create New App** > **From a manifest**.
2. Paste [`docs/slack-app-manifest.yaml`](docs/slack-app-manifest.yaml), change `Jimmy` to the agent's name, and select **Create**.
3. Install the app to your workspace, then copy the **Bot User OAuth Token** (`xoxb-...`) from **OAuth & Permissions**.
4. In **Basic Information** > **App-Level Tokens**, create a token with the `connections:write` scope and copy it (`xapp-...`).
5. Invite the bot to the channel where it should answer, and copy the channel ID from the channel's details.

The apps use Socket Mode, so the agents don't need a public URL.

## Step 2: Create and enroll the proxy

The proxy runs on your own infrastructure, on a network your agents can reach.

1. In Agent Vault, go to **Proxies** and select **Create Proxy**.
2. Enter a **Name**, expand **Advanced Options**, and set **Traffic Policy** to **Access bundle hosts only**. With the default **Any host** policy, the proxy forwards requests to hosts outside the access bundle instead of blocking them.
3. Select **Create**. The **Enrollment Token** dialog shows a one-time token that expires in an hour, with the commands to enroll the proxy.
4. On the machine that will run the proxy, run the command from the dialog:

   ```
   infisical agent-vault proxy --enrollment-token <enrollment-token> --domain <your-infisical-url>
   ```

5. Copy the proxy's fingerprint from the **Certificate Authority** column on the **Proxies** page. The agents use the fingerprint to check that they're talking to your proxy.

The proxy listens on port 17323 and saves its enrollment in a state directory (`~/.infisical/agent-vault` by default). After the first run, start it without the token:

```
infisical agent-vault proxy --domain <your-infisical-url>
```

If the proxy runs in a container, mount persistent storage at the state directory. If the state directory is lost, the proxy can't start until you select **New Enrollment Token** on the proxy's menu and enroll it again.

## Step 3: Create the access bundles

Create one access bundle per agent, then add the services from [Agent Vault configuration](#agent-vault-configuration) to each one.

1. In Agent Vault, go to **Access Bundles** and select **Create Access Bundle**.
2. Enter a name, such as `on-call-infra`, and select **Create**.
3. Open the access bundle and select **Add Service**.
4. Pick the template for the API, or select **Custom** to enter the host and credential type yourself. Paste the credential and select **Add Service**.
5. Repeat for each service in the access bundle.

Each Slack app sends two tokens to `slack.com`: the bot token for API calls, and the app-level token to open its Socket Mode connection. A Bearer credential would replace both tokens with one value, so the Slack service uses Pass-through with two substitutions instead:

1. Select **Custom**, enter `slack.com, *.slack.com` as the host, and set the credential type to **Pass-through**. The `*.slack.com` host covers the Socket Mode connection.
2. On the **Credential** step, expand **Advanced Options** and select **Add Substitution**.
3. Enter `xoxb-avplaceholder-jimmy-bot` in **Replace**, paste the real bot token in **With**, and select **Headers** under **Replace In**.
4. Add a second substitution that replaces `xapp-avplaceholder-jimmy-app` with the real app-level token.

## Step 4: Create a machine identity for each agent

1. Create a [machine identity](https://infisical.com/docs/documentation/platform/identities/machine-identities) with Universal Auth, and create a client secret for it.
2. In Agent Vault, go to **Access Control** > **Machine Identities** and select **Add Machine Identity**. Select the identity and choose **Member** in **Product Role**.
3. Open the agent's access bundle, select **Options** > **Manage Access** > **Grant Access**, and grant it to the identity.

Keep the identity's client ID and client secret. The client secret is the only real secret the agent's container holds.

## Step 5: Run an agent locally

1. Install the dependencies and run the checks:

   ```
   npm install
   npm run typecheck && npm test
   ```

2. Copy `.env.example` to `.env`, and fill in the values that aren't secrets: `AGENT`, `AGENT_CHANNEL_ID`, `AGENT_ALLOWLIST`, and Jimmy's `SENTRY_ORG`, `SENTRY_PROJECT`, and `GITHUB_REPO`. Leave the API keys as placeholders.

3. Start the agent behind the proxy, logged in as the agent's machine identity:

   ```
   export INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=<client-id>
   export INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=<client-secret>
   infisical agent-vault run --access-bundle on-call-infra --proxy <proxy-host>:17323 -- npm start
   ```

4. Mention the bot in its channel.

To ask the agent one question without Slack, replace `npm start` with `npm run ask -- jimmy "What can you do?"`.

## Step 6: Deploy

The `Dockerfile` builds one image for every agent. The image starts the bot with `infisical agent-vault run` and removes the machine identity's credentials from the bot's environment before the bot starts.

Deploy the image once per agent, and set these environment variables in your platform's settings for each service, such as the **Environment** page of a Render service:

| Variable | Value |
| --- | --- |
| `AGENT` | `jimmy` or `penny` |
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` | The agent's machine identity client ID |
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` | The agent's machine identity client secret |
| `INFISICAL_AGENT_VAULT_PROXY_ADDRESS` | The proxy's address on your private network, such as `<proxy-host>:17323` |
| `INFISICAL_AGENT_VAULT_ACCESS_BUNDLE` | The agent's access bundle, such as `on-call-infra` |
| `INFISICAL_AGENT_VAULT_CA_FINGERPRINT` | The proxy's fingerprint from [Step 2](#step-2-create-and-enroll-the-proxy) |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | The placeholders from the Slack service's substitutions |
| `ANTHROPIC_API_KEY`, `SENTRY_AUTH_TOKEN`, `GITHUB_TOKEN`, `STRIPE_API_KEY` | `placeholder` |
| `AGENT_CHANNEL_ID`, `AGENT_ALLOWLIST`, `SLACK_WORKSPACE_URL` | Same as your local `.env` |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `GITHUB_REPO` | Jimmy only |

We run each agent as a Render background worker, and the proxy as a Render private service with a persistent disk at `/etc/infisical/agent-vault`.

## Add a tool

1. In the agent's folder, write the tool with `tool()` from the Agent SDK. [`src/agents/penny/stripe.ts`](src/agents/penny/stripe.ts) is a short example.
2. Read the API key from an environment variable that holds a placeholder, and send it in a header. The proxy can't replace a credential in the request body unless the service has a body substitution.
3. Add the tool to an MCP server in the agent's `index.ts`, and give it a status line in `progressLabel`.
4. Add a service for the API's host to the agent's access bundle.

## Add an agent

1. Copy `src/agents/penny` to a new folder and change the prompt, `SOUL.md`, and tools.
2. Create a Slack app, an access bundle, and a machine identity for the new agent.
3. Run it with `AGENT=<folder-name>`.

## Limits of this version

- Each container opens one session, so the session log mixes requests from everyone who talks to that agent. Per-conversation sessions need an orchestrator that opens a session for each Slack thread
- The agents run without a sandbox. They can only call the tools in this repo, which is why the SDK's built-in tools are off
- The bot checks the allowlist and channel itself. Agent Vault doesn't know who in Slack asked

## License

MIT
