FROM node:24-slim

# Keep the Infisical CLI at 0.45.13 or later: older versions call API routes that Infisical has removed.
ARG INFISICAL_CLI_VERSION=0.45.13
ARG CLAUDE_CODE_VERSION=2.1.330
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git \
    && curl --tlsv1.2 -sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | bash \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends infisical=${INFISICAL_CLI_VERSION} gh \
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

# `exec` makes the CLI PID 1, so it gets the stop signal and revokes the session.
CMD exec infisical agent-vault run \
      --access-bundle=on-call \
      --label="on-call agent" \
      --ca-fingerprint="$INFISICAL_AGENT_VAULT_CA_FINGERPRINT" \
      -- node src/main.ts
