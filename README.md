# Agent reference architectures

Reference architectures for running AI agents with [Infisical Agent Vault](https://infisical.com/docs/documentation/platform/agent-vault/overview). Each folder is a self-contained project with its own README, dependencies, and Dockerfile.

| Architecture | What it shows |
| --- | --- |
| [`slack-agent-basic`](slack-agent-basic) | Two Slack agents, one long-running container each, with custom tools and no sandbox. Start here. |
| [`slack-agent-sandbox`](slack-agent-sandbox) (Atlas) | A Slack agent with a full shell that runs each message in a disposable [SPACE](https://github.com/perplexityai/SPACE) Firecracker VM, reachable only through the Agent Vault proxy. |
| [`slack-agent-modal`](slack-agent-modal) (Apollo) | Atlas on [Modal Sandboxes](https://modal.com/docs/guide/sandboxes): no sandbox cluster to run, and a copy of the Agent Vault proxy as a sidecar in every sandbox, its only way out. |

## License

MIT
