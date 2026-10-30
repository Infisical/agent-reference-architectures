import { test } from "node:test";
import assert from "node:assert/strict";
import { createLineSplitter, parseSse } from "./sse.js";
import { collect } from "./test-helpers/fakes.js";

async function* chunks(...parts: string[]) {
  const encoder = new TextEncoder();
  for (const part of parts) yield encoder.encode(part);
}

test("line splitter: joins lines split across chunks and handles CRLF split between chunks", () => {
  const lines = createLineSplitter();
  assert.deepEqual(lines.push('{"a":'), []);
  assert.deepEqual(lines.push('1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(lines.push(":2}\r"), []);
  assert.deepEqual(lines.push("\nlast"), ['{"b":2}']);
  assert.deepEqual(lines.end(), ["last"]);
  assert.deepEqual(lines.end(), []);
});

test("parseSse: named events, multi-line data, ids and comments", async () => {
  const events = await collect(
    parseSse(chunks(": keepalive\n", "event: stdout\nid: 1\ndata: hel", "lo\ndata: world\n\n", "data:x\n\n")),
  );
  assert.deepEqual(events, [
    { event: "stdout", data: "hello\nworld", id: "1" },
    { event: "message", data: "x", id: "1" },
  ]);
});

test("parseSse: a multi-byte character split across chunks decodes intact", async () => {
  const bytes = new TextEncoder().encode("data: é\n\n");
  async function* split() {
    yield bytes.slice(0, 7);
    yield bytes.slice(7);
  }
  assert.deepEqual(await collect(parseSse(split())), [{ event: "message", data: "é" }]);
});

test("parseSse: drops an event cut off before its blank line", async () => {
  assert.deepEqual(await collect(parseSse(chunks("data: done\n\n", "data: cut"))), [{ event: "message", data: "done" }]);
});

test("line splitter: a line past the limit throws instead of growing without end", () => {
  const lines = createLineSplitter(8);
  assert.deepEqual(lines.push("12345678\n1234"), ["12345678"]);
  assert.throws(() => lines.push("56789"), /output line over 8 characters/);
});
