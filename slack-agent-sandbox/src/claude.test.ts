import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClaudeHarness, parseClaudeEvent } from "./claude.js";

const fixtureLines = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim());

const harness = createClaudeHarness({ template: "coding-agent:v1" });

test("command: headless stream-json, prompt from stdin, instructions from the file", () => {
  assert.equal(
    harness.command({ instructionsPath: "/home/user/workspace/AGENTS.md" }),
    "env ANTHROPIC_API_KEY=agent-vault-brokered CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 " +
      "claude -p --output-format stream-json --verbose --permission-mode bypassPermissions " +
      `--append-system-prompt "$(cat '/home/user/workspace/AGENTS.md')"`,
  );
});

test("command: --model only when set, shell-quoted", () => {
  const withModel = createClaudeHarness({ template: "t", model: "claude-sonnet-5-5" });
  assert.match(withModel.command({ instructionsPath: "/a" }), / --model 'claude-sonnet-5-5' /);
  assert.doesNotMatch(harness.command({ instructionsPath: "/a" }), /--model/);
});

test("parseLine: the recorded run yields the described Bash call, its text, then the final answer", () => {
  const answer = "The current directory has a single file: `note.txt`.";
  assert.deepEqual(fixtureLines("claude.jsonl").flatMap(harness.parseLine), [
    { type: "tool", name: "Bash", detail: "List files in current directory" },
    { type: "narration", text: answer },
    // The recording predates duration_api_ms, so the API time is unknown.
    { type: "final", text: answer, stats: { durationMs: 3759, apiMs: undefined, turns: 2 } },
  ]);
});

test("parseLine: skips lines that aren't JSON", () => {
  assert.deepEqual(harness.parseLine("Welcome to Claude Code"), []);
});

test("parseClaudeEvent: MCP tool names read as server/tool; a tool with no describable input has no detail", () => {
  const event = {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "mcp__github__list_issues", input: { query: "is:open" } },
        { type: "tool_use", name: "TodoWrite", input: { todos: [] } },
      ],
    },
  };
  assert.deepEqual(parseClaudeEvent(event), [
    { type: "tool", name: "github/list_issues", detail: "is:open" },
    { type: "tool", name: "TodoWrite", detail: undefined },
  ]);
});

test("parseLine: an error result throws with the CLI's error text", () => {
  const [errorLine] = fixtureLines("claude-error.jsonl");
  assert.throws(() => harness.parseLine(errorLine), /No conversation found with session ID/);
});

test("parseClaudeEvent: ignores events it doesn't care about", () => {
  assert.deepEqual(parseClaudeEvent({ type: "rate_limit_event" }), []);
  assert.deepEqual(parseClaudeEvent(null), []);
});

test("parseLine: stats keep only finite numbers, since the agent writes this line", () => {
  const line = JSON.stringify({
    type: "result",
    result: "ok",
    duration_ms: "1\nrun forged timings: boot 0.0s",
    duration_api_ms: Infinity,
    num_turns: 3,
  });
  assert.deepEqual(harness.parseLine(line), [
    { type: "final", text: "ok", stats: { durationMs: undefined, apiMs: undefined, turns: 3 } },
  ]);
});
