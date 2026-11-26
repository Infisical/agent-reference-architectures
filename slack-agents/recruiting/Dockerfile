FROM node:24-slim

# The Infisical CLI runs the agent behind the Agent Vault proxy. Keep it at 0.45.13 or later: older
# versions call API routes that Infisical has removed.
ARG INFISICAL_CLI_VERSION=0.45.13
ARG CLAUDE_CODE_VERSION=2.1.330
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl --tlsv1.2 -sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | bash \
    && apt-get install -y --no-install-recommends infisical=${INFISICAL_CLI_VERSION} \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && claude --version

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .

# Claude Code refuses bypassPermissions as root. /app stays owned by root, so the agent works in its home
# folder and can't change the bridge or its own prompt.
USER node

# `agent-vault run` logs in as the agent's machine identity, opens a session on its access bundle, and
# starts the Slack bot behind the proxy. The bot runs Claude Code for each message, which inherits the
# proxy settings. `exec` makes the CLI PID 1 so it gets signals and revokes the session when the container stops.
CMD exec infisical agent-vault run \
      --access-bundle=recruiting \
      --label="recruiting agent" \
      --ca-fingerprint="$INFISICAL_AGENT_VAULT_CA_FINGERPRINT" \
      -- node src/main.ts
