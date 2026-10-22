// Real tool calls never show up as text: the SDK reports them as structured events, and only the
// model's final prose reaches Slack. So if that prose contains tags like <tool_call> or
// <function_calls>, the model didn't call anything. It wrote a fake transcript of itself using
// tools, invented results included. run-agent.ts refuses to post that, and slack.ts strips it
// from past bot messages so one slip can't teach the model to repeat it.

const BLOCK_TAGS = ["tool_call", "tool_response", "tool_use", "tool_result", "function_calls", "function_results?", "invoke"];
const TAGS = BLOCK_TAGS.join("|");

// Anchored on the tag name right after "<" so Slack's <url|label> links and <@U123> mentions never match.
const ANY_TAG = new RegExp(`<\\/?(?:antml:)?(?:${TAGS})\\b`, "i");
const BALANCED_BLOCK = new RegExp(`<(${TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "gi");
const STRAY_TAG = new RegExp(`<\\/?(?:antml:)?(?:${TAGS}|parameter)\\b[^>]*>`, "gi");

export function containsToolProtocolSyntax(text: string): boolean {
  return ANY_TAG.test(text);
}

/** Drops whole tag blocks (and the invented output inside), then any stray tags, keeping the prose. */
export function stripToolProtocolSyntax(text: string): string {
  if (!containsToolProtocolSyntax(text)) return text;
  return text.replace(BALANCED_BLOCK, "").replace(STRAY_TAG, "").replace(/\n{3,}/g, "\n\n").trim();
}
