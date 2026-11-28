
export interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}

export type StreamEvent =
  | { kind: "tool"; tool: ToolUse }
  | { kind: "result"; text: string; isError: boolean }
  | { kind: "other" };

export function parseStreamLine(line: string): StreamEvent {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    return { kind: "other" };
  }

  if (event.type === "result") {
    const isError = event.is_error === true || event.subtype !== "success";
    const errors = Array.isArray(event.errors) ? event.errors.filter((e): e is string => typeof e === "string") : [];
    const text = typeof event.result === "string" && event.result ? event.result : errors.join("\n");
    return { kind: "result", text, isError };
  }

  if (event.type === "assistant") {
    const content = (event.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      const block = content.find((b) => b?.type === "tool_use");
      if (block) return { kind: "tool", tool: { name: String(block.name), input: block.input ?? {} } };
    }
  }

  return { kind: "other" };
}

export function progressLabel({ name, input }: ToolUse): string | null {
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  const file = (key: string) => text(key).split("/").pop() || "a file";

  if (name.startsWith("mcp__")) {
    const [, server, tool] = name.split("__");
    return `Calling ${server}${tool ? ` (${tool})` : ""}…`;
  }
  switch (name) {
    case "Bash": {
      const command = text("command").split("\n")[0];
      return command ? `Running \`${command.length > 60 ? `${command.slice(0, 60)}…` : command}\`` : "Running a command…";
    }
    case "Read":
      return `Reading ${file("file_path")}…`;
    case "Edit":
    case "MultiEdit":
    case "Write":
      return `Editing ${file("file_path")}…`;
    case "Grep":
    case "Glob":
      return "Searching the code…";
    case "WebFetch":
      return URL.canParse(text("url")) ? `Fetching ${new URL(text("url")).host}…` : "Fetching a page…";
    case "TodoWrite":
      return null;
    default:
      return `Using ${name}…`;
  }
}
