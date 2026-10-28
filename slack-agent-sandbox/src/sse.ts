/**
 * Splits text that arrives in arbitrary chunks into lines. A stream chunk can end mid-line, or
 * between the \r and \n of a CRLF, so the unfinished tail waits for the next chunk.
 */
export function createLineSplitter() {
  let buffer = "";
  // buffer[0, scanned) is known to hold no line break, so a long line split over many chunks
  // isn't rescanned from its start on every chunk.
  let scanned = 0;
  return {
    /** Complete lines in `chunk` plus whatever was waiting, without their line endings. */
    push(chunk: string): string[] {
      buffer += chunk;
      const lines: string[] = [];
      let start = 0;
      let i = scanned;
      for (; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch !== "\n" && ch !== "\r") continue;
        // A trailing \r may be the first half of a CRLF split across chunks.
        if (ch === "\r" && i === buffer.length - 1) break;
        lines.push(buffer.slice(start, i));
        if (ch === "\r" && buffer[i + 1] === "\n") i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
      scanned = i - start;
      return lines;
    },
    /** The last line, if the stream didn't end with a line break. */
    end(): string[] {
      const rest = buffer.replace(/\r$/, "");
      buffer = "";
      scanned = 0;
      return rest ? [rest] : [];
    },
  };
}

export interface SseEvent {
  /** "message" when the stream gives no event name. */
  event: string;
  data: string;
  id?: string;
}

/** Parses a text/event-stream body (per the WHATWG spec) into events. */
export async function* parseSse(body: AsyncIterable<Uint8Array | string>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const lines = createLineSplitter();
  let event = "";
  let data: string[] = [];
  let id: string | undefined;

  function* handle(line: string): Generator<SseEvent> {
    if (line === "") {
      if (data.length) yield { event: event || "message", data: data.join("\n"), ...(id !== undefined && { id }) };
      event = "";
      data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }

  for await (const chunk of body) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (const line of lines.push(text)) yield* handle(line);
  }
  // An event not followed by a blank line is incomplete; the spec drops it.
  for (const line of lines.push(decoder.decode())) yield* handle(line);
}
