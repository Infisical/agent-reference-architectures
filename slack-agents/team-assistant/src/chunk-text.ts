// Slack collapses long messages, so long answers go out as several replies.
export const SLACK_MAX_CHARS = 3900;

const FENCE = "```";

// A code block cut by a break is closed and reopened, so both halves keep their formatting.
export function chunkText(text: string, max = SLACK_MAX_CHARS): string[] {
  // Room for the fence that closes a chunk and the one that reopens the next.
  const limit = max - (FENCE.length + 1) * 2;
  const chunks: string[] = [];
  let current = "";
  let inFence = false;

  const flush = () => {
    if (!current) return;
    chunks.push(inFence ? `${current}\n${FENCE}` : current);
    current = inFence ? FENCE : "";
  };

  for (const line of text.split("\n")) {
    if (line.length > limit) {
      flush();
      for (let i = 0; i < line.length; i += limit) {
        current = current ? `${current}\n${line.slice(i, i + limit)}` : line.slice(i, i + limit);
        flush();
      }
    } else {
      if (current && current.length + line.length + 1 > limit) flush();
      current = current ? `${current}\n${line}` : line;
    }
    if (line.trimStart().startsWith(FENCE)) inFence = !inFence;
  }
  if (current && current !== FENCE) chunks.push(current);
  return chunks.length > 0 ? chunks : [""];
}
