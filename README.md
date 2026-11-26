# Agent reference architectures

Reference architectures for running AI agents with [Infisical Agent Vault](https://infisical.com/docs/documentation/platform/agent-vault/overview). Each folder holds one agent, with a README that takes you from an empty Agent Vault project to a running agent.

| Architecture | What it shows |
| --- | --- |
| [`slack-agents/on-call`](slack-agents/on-call) | A Slack agent that runs Claude Code to investigate Sentry errors and fix them on GitHub, on [Docker](slack-agents/on-call/docker) or a [VM](slack-agents/on-call/vm). |
| [`slack-agents/coding`](slack-agents/coding) | A Slack agent that runs Claude Code to answer questions about a repo and open pull requests, on Docker or a Linux VM. |
| [`slack-agents/recruiting`](slack-agents/recruiting) | A Slack agent that answers questions about jobs and candidates from Ashby, on Docker or a Linux VM. |
| [`telegram-agents/openclaw`](telegram-agents/openclaw) | An OpenClaw assistant you message on Telegram, on a DigitalOcean Droplet. |
| [`telegram-agents/hermes`](telegram-agents/hermes) | A Hermes Agent you message on Telegram, on a DigitalOcean Droplet. |

## License

MIT
