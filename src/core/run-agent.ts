import { query } from "@anthropic-ai/claude-agent-sdk";
import { CLI_CONTEXT, type Agent, type RequestContext } from "./agent.ts";
import { AGENT_MODEL } from "./config.ts";
import { containsToolProtocolSyntax } from "./tool-syntax-guard.ts";

export interface RunAgentOptions {
  onProgress?: (message: string) => void;
  context?: RequestContext;
}

/** Run one turn of the agent and return its final answer. */
export async function runAgent(agent: Agent, prompt: string, options: RunAgentOptions = {}): Promise<string> {
  const { onProgress, context = CLI_CONTEXT } = options;
  const mcpServers = agent.mcpServers(context);
  // Derived from the mounted servers so the two lists can't drift apart.
  const allowedTools = Object.keys(mcpServers).map((name) => `mcp__${name}__*`);
  let result = "";

  for await (const event of query({
    prompt,
    options: {
      model: AGENT_MODEL,
      systemPrompt: agent.systemPrompt,
      mcpServers,
      allowedTools,
      // No built-in tools (bash, file read/write), so the agent can't run commands or read its env.
      tools: [],
      permissionMode: "bypassPermissions",
      persistSession: false,
      // Set in the Dockerfile. See the note there.
      pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE,
    },
  })) {
    if (event.type === "assistant" && onProgress) {
      for (const block of event.message.content) {
        if (block.type === "tool_use") {
          const label = agent.progressLabel(block.name, block.input as Record<string, unknown>);
          if (label) onProgress(label);
        }
      }
    }
    if (event.type === "result" && event.subtype === "success") {
      result = event.result;
    }
  }

  if (containsToolProtocolSyntax(result)) {
    console.error("Model wrote tool-call syntax into its answer instead of calling tools:", result.slice(0, 500));
    throw new Error("Model fabricated tool-call syntax; refusing to relay the answer.");
  }
  return result;
}
