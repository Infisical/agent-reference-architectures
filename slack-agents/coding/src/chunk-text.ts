export const SLACK_MAX_CHARS = 3900;

const FENCE = "```";
const MAX_OPENER = 32;

const fenceCount = (line: string) => line.split(FENCE).length - 1;

export function chunkText(text: string, max = SLACK_MAX_CHARS): string[] {
  const limit = max - (FENCE.length + 1) - (MAX_OPENER + 1);
  const chunks: string[] = [];
  let current = "";
  let opener: string | undefined;

  const flush = () => {
    if (!current) return;
    chunks.push(opener ? `${current}\n${FENCE}` : current);
    current = opener ?? "";
  };

  for (const line of text.split("\n")) {
    if (line.length > limit) {
      flush();
      for (let i = 0; i < line.length; i += limit) {
        current = current ? `${current}\n${line.slice(i, i + limit)}` : line.slice(i, i + limit);
        flush();
      }
    } else {
      if (current && current !== opener && current.length + line.length + 1 > limit) flush();
      current = current ? `${current}\n${line}` : line;
    }
    // ```npm install``` on one line opens and closes a block.
    if (fenceCount(line) % 2 === 1) {
      const trimmed = line.trim();
      opener = opener ? undefined : trimmed.startsWith(FENCE) && trimmed.length <= MAX_OPENER ? trimmed : FENCE;
    }
  }
  if (current && current !== opener) chunks.push(current);
  return chunks.length > 0 ? chunks : [""];
}
