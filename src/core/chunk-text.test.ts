import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText } from "./chunk-text.ts";

test("returns a single chunk when the text fits", () => {
  assert.deepEqual(chunkText("line one\nline two", 100), ["line one\nline two"]);
});

test("returns one empty chunk for empty input", () => {
  assert.deepEqual(chunkText(""), [""]);
});

test("breaks on line boundaries, never mid-line", () => {
  assert.deepEqual(chunkText("aaaa\nbbbb\ncccc", 9), ["aaaa\nbbbb", "cccc"]);
});

test("hard-splits a single line longer than the limit", () => {
  assert.deepEqual(chunkText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
});

test("flushes the buffer before hard-splitting an over-long line", () => {
  assert.deepEqual(chunkText("short\nabcdefghij", 5), ["short", "abcde", "fghij"]);
});
