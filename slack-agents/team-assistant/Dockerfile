FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .

# The orchestrator only talks to Slack, Modal and Infisical. Claude Code runs in the Modal sandboxes, not here.
USER node

CMD ["node", "src/main.ts"]
