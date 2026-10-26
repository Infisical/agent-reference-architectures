import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTool, text } from "./tool-result.ts";

describe("text", () => {
  it("wraps a string in the SDK tool-result shape", () => {
    assert.deepEqual(text("hello"), { content: [{ type: "text", text: "hello" }] });
  });
});

describe("runTool", () => {
  it("returns the body's result when it succeeds", async () => {
    const result = await runTool("unused", async () => text("ok"));
    assert.deepEqual(result, text("ok"));
  });

  it("returns the error message and logs when the body throws", async (t) => {
    const errorLog = t.mock.method(console, "error", () => {});
    const result = await runTool("Something went wrong.", async () => {
      throw new Error("boom");
    });
    assert.deepEqual(result, text("Something went wrong."));
    assert.equal(errorLog.mock.callCount(), 1);
  });
});
