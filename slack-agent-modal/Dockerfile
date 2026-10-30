# Apollo: the Slack Socket Mode orchestrator. It only makes outbound connections (Slack, Modal,
# Infisical), so the image exposes no ports. Agent CLIs run inside Modal Sandboxes, never here.
#
#   docker build -t apollo .
#
# Configuration is environment variables at run time (see .env.example); none are baked in.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY package.json ./
# Read at startup from the working directory.
COPY instructions/AGENTS.md ./instructions/AGENTS.md
# The run journal, at STATE_DIR's default (./state). Owned by the runtime user so a fresh named
# volume mounted here inherits it.
RUN mkdir state && chown node:node state
USER node
CMD ["node", "dist/src/main.js"]
