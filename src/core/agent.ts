import { readFileSync } from "node:fs";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

export type McpServer = ReturnType<typeof createSdkMcpServer>;

/** Who triggered a run and where. Comes from the Slack event, never from the model. */
export interface RequestContext {
  requesterName: string;
  threadUrl?: string;
}

export const CLI_CONTEXT: RequestContext = { requesterName: "CLI" };

/** Everything that makes one agent different from another. The rest lives in core. */
export interface Agent {
  name: string;
  systemPrompt: string;
  /** Built per request, so a tool can record who asked. */
  mcpServers(ctx: RequestContext): Record<string, McpServer>;
  /** The status line shown in Slack while a tool runs, or null to keep the last one. */
  progressLabel(toolName: string, input: Record<string, unknown>): string | null;
}

/**
 * An in-process MCP server. alwaysLoad keeps every tool schema in the first prompt. Without it the
 * SDK hides MCP tools behind tool search, and the model tends to describe calls instead of making them.
 */
export function mcpServer(name: string, tools: Parameters<typeof createSdkMcpServer>[0]["tools"]): McpServer {
  return createSdkMcpServer({ name, version: "1.0.0", tools, alwaysLoad: true });
}

/** The agent's prompt plus its SOUL.md (voice only), with {{AGENT_NAME}} filled in. */
export function buildSystemPrompt(name: string, prompt: string, soulPath: URL): string {
  const soul = readFileSync(soulPath, "utf8").trim().replaceAll("{{AGENT_NAME}}", name);
  return `${prompt}\n\n${soul}`;
}

/** slack.ts puts this before the triggering message when it sends a thread transcript. */
export const LATEST_MESSAGE_MARKER = "Respond to this latest message:";

/** Prompt rules every agent shares: reading the thread, Slack formatting, and blocked hosts. */
export const SHARED_RULES = `## Systems outside your access
- When asked for something from a system that isn't yours, don't refuse up front. Try it with http_get against that system's real API, so Agent Vault makes the decision.
- If http_get comes back BLOCKED by Agent Vault, say so plainly: name the host, say it isn't in your access bundle, and that you hold no credential for it. Don't retry other URLs for the same system.
- If asked what you can do, describe your capabilities without calling any tools.

## Reading the request
- You may be given a Slack thread as context. Use it, then answer the latest message.

## Slack formatting
- Concise and direct, no emojis. Use *bold*, _italic_, • bullets, and \`\`\` code blocks.
- Links use Slack's <url|label> syntax, never Markdown [label](url).`;
