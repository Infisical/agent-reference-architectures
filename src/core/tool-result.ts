/** Wrap a string in the tool result shape the Agent SDK expects. */
export function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/**
 * Run a tool handler, turning any thrown error into `errorMessage` for the model. The handler only
 * deals with its happy path, and the model gets a plain sentence instead of a stack trace.
 */
export async function runTool<T>(
  errorMessage: string,
  body: () => Promise<T>,
  logLabel = "Tool error:",
): Promise<T | ReturnType<typeof text>> {
  try {
    return await body();
  } catch (err) {
    console.error(logLabel, err);
    return text(errorMessage);
  }
}
