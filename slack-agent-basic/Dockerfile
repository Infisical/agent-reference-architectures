FROM --platform=linux/amd64 node:24-slim

# The Infisical CLI runs the agent behind the Agent Vault proxy. `agent-vault run` needs 0.43.132 or
# later, and header placeholder substitution (used for the Slack tokens) needs 0.43.133 or later.
ARG INFISICAL_CLI_VERSION=0.43.143
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl --tlsv1.2 -sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | bash \
    && apt-get update && apt-get install -y --no-install-recommends infisical=${INFISICAL_CLI_VERSION} \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src

# The Agent SDK can pick its musl binary on glibc Linux and fail to start it
# (anthropics/claude-agent-sdk-typescript#296), so point it at the glibc one.
ENV CLAUDE_CODE_EXECUTABLE=/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude
RUN test -x "$CLAUDE_CODE_EXECUTABLE"

# Claude Code refuses bypassPermissions as root.
RUN chown -R node:node /app
USER node

ENV INFISICAL_AGENT_VAULT_TTL=never

# On start, `agent-vault run` logs in as the agent's machine identity, opens a session on its access
# bundle, points HTTPS at the proxy, and trusts the proxy's CA. `env -u` then starts the bot without
# the identity credentials, so the only real secret in the container never reaches the agent. The CLI
# keeps its own copy to revoke the session on exit. `exec` makes the CLI PID 1 so it gets signals.
CMD exec infisical agent-vault run \
      --access-bundle="${INFISICAL_AGENT_VAULT_ACCESS_BUNDLE}" \
      --ttl="${INFISICAL_AGENT_VAULT_TTL}" \
      ${INFISICAL_AGENT_VAULT_CA_FINGERPRINT:+--ca-fingerprint="$INFISICAL_AGENT_VAULT_CA_FINGERPRINT"} \
      -- env -u INFISICAL_UNIVERSAL_AUTH_CLIENT_ID -u INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET \
      node src/main.ts
