import { shellQuote, type Harness, type HarnessEvent } from "./harness.js";

// Input fields that usually say what a tool call is about, best first. `description` beats
// `command` so a described shell call shows the description, not the raw command.
const DETAIL_KEYS = ["description", "title", "file_path", "filePath", "path", "pattern", "query", "url", "command"];

/** A tool event's `detail`: the first well-known string field of its input. */
export function describeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const key of DETAIL_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

interface ClaudeContentBlock {
  type?: string;
  name?: string;
  text?: string;
  input?: unknown;
}

interface ClaudeStreamEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  duration_ms?: unknown;
  duration_api_ms?: unknown;
  num_turns?: unknown;
  message?: { content?: ClaudeContentBlock[] };
}

/** `mcp__github__create_issue` reads as `github/create_issue`; built-in tool names pass through. */
function claudeToolName(name?: string): string | undefined {
  const match = name?.match(/^mcp__(.+?)__(.+)$/);
  return match ? `${match[1]}/${match[2]}` : name;
}

/** Maps one `claude --output-format stream-json` event to harness events. Throws on an error result. */
export function parseClaudeEvent(raw: unknown): HarnessEvent[] {
  if (!raw || typeof raw !== "object") return [];
  const event = raw as ClaudeStreamEvent;

  if (event.type === "assistant") {
    return (event.message?.content ?? []).flatMap((block): HarnessEvent[] => {
      if (block.type === "text" && block.text?.trim()) return [{ type: "narration", text: block.text.trim() }];
      if (block.type === "tool_use") {
        return [{ type: "tool", name: claudeToolName(block.name), detail: describeToolInput(block.input) }];
      }
      return [];
    });
  }

  if (event.type === "result") {
    if (event.is_error) {
      const detail = event.errors?.join("; ") || event.result || event.subtype || "unknown error";
      throw new Error(`claude run failed: ${detail}`);
    }
    // The agent controls this line, so only finite numbers are kept: anything else could forge log lines.
    const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
    const stats = { durationMs: num(event.duration_ms), apiMs: num(event.duration_api_ms), turns: num(event.num_turns) };
    return [{ type: "final", text: event.result ?? "", stats }];
  }

  return [];
}

export interface ClaudeHarnessOptions {
  template: string;
  /** Passed to --model; Claude Code's default when unset. */
  model?: string;
}

/**
 * Stands in for the credentials the VM never holds, such as the Anthropic key: Claude Code won't
 * start without one, and Agent Proxy overwrites the header with the real credential on the way out.
 */
export const CREDENTIAL_PLACEHOLDER = "agent-vault-brokered";

/**
 * Remote MCP servers every run gets, as `claude mcp add --transport http` would add them. Each
 * carries a placeholder bearer token for Agent Proxy to overwrite (README "MCP servers").
 */
const MCP_SERVERS = {
  linear: {
    type: "http",
    url: "https://mcp.linear.app/mcp",
    headers: { Authorization: `Bearer ${CREDENTIAL_PLACEHOLDER}` },
  },
};

/**
 * Claude Code in a Modal Sandbox. With -p and no prompt argument it reads the prompt from stdin, so
 * the prompt never appears in the command Modal records. Claude Code reads CLAUDE.md, not
 * AGENTS.md, so the instructions file is passed as an appended system prompt. Non-essential
 * traffic (telemetry, update checks) is off: the proxy refuses hosts outside the bundle.
 */
export function createClaudeHarness({ template, model }: ClaudeHarnessOptions): Harness {
  return {
    name: "claude",
    template,
    command({ instructionsPath }) {
      const args = [
        "env",
        `ANTHROPIC_API_KEY=${CREDENTIAL_PLACEHOLDER}`,
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
        "DISABLE_AUTOUPDATER=1",
        "claude",
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
        "--mcp-config",
        shellQuote(JSON.stringify({ mcpServers: MCP_SERVERS })),
      ];
      if (model) args.push("--model", shellQuote(model));
      args.push("--append-system-prompt", `"$(cat ${shellQuote(instructionsPath)})"`);
      return args.join(" ");
    },
    parseLine(line) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        // Banners and warnings that aren't JSON.
        return [];
      }
      return parseClaudeEvent(raw);
    },
  };
}
