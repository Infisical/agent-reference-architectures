# AGENTS.md

Reference architectures for running AI agents with Infisical Agent Vault. Each folder is a self-contained project. A new example gets its own folder with everything it needs to run, even when that copies code from another folder.

| Folder | Status |
| --- | --- |
| `slack-agents/on-call/` | A Slack agent that runs Claude Code. Read its `AGENTS.md` |
| `slack-agents/coding/` | A Slack agent that runs Claude Code and opens pull requests. Read its `AGENTS.md` |

## Setting up an example for a person

The agent code never calls Infisical. `infisical agent-vault run` wraps the agent, opens a session, and routes its HTTPS traffic through the Agent Vault proxy, which attaches each credential. Expect no API keys in the agent's environment.

- Never ask the person to paste a credential or secret into the chat. Credentials go into Agent Vault services, which the person enters in the Agent Vault UI. Secrets for running the agent, the proxy token and the machine identity's client secret, go into the deployment's secret file, which the person fills in.
- The person has to do the steps in third-party UIs: creating the Slack app and its tokens, creating the Sentry, GitHub, and Anthropic credentials, and creating the Agent Vault proxy, access bundle, services, and machine identity. Tell them exactly what to create and what to name it, from the example's README, and wait for them to confirm.
- You can do the rest: install dependencies, fill in the `.env` settings that aren't secret once the person gives them to you, run the checks, and start the agent.
- Names must match exactly between the repo and Agent Vault: the access bundle's name, and the Slack placeholders in `.env` and the Slack service's substitutions.
- Use Infisical CLI 0.45.13 or later. Older versions call API routes that Infisical has removed.
