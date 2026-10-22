import { test } from "node:test";
import assert from "node:assert/strict";
import { containsToolProtocolSyntax, stripToolProtocolSyntax } from "./tool-syntax-guard.ts";

const FABRICATED = `Let me check Sentry.

<tool_call>
{"name": "list_sentry_issues", "arguments": {}}
</tool_call>
<tool_response>
Found 1 issue: TypeError in src/pricing.js
</tool_response>

The checkout error comes from src/pricing.js.`;

test("detects a fabricated tool transcript", () => {
  assert.equal(containsToolProtocolSyntax(FABRICATED), true);
});

test("detects the other textual tool-call conventions", () => {
  assert.equal(containsToolProtocolSyntax('<function_calls><invoke name="x">'), true);
  assert.equal(containsToolProtocolSyntax("result: <tool_use>{}</tool_use>"), true);
  assert.equal(containsToolProtocolSyntax("</tool_call>"), true);
});

test("ignores ordinary Slack markup", () => {
  assert.equal(containsToolProtocolSyntax("See <https://github.com/acme/app|the repo>."), false);
  assert.equal(containsToolProtocolSyntax("Ask <@U123> about the tool."), false);
  assert.equal(containsToolProtocolSyntax(""), false);
});

test("strips the fake exchange and keeps the prose", () => {
  const cleaned = stripToolProtocolSyntax(FABRICATED);
  assert.equal(containsToolProtocolSyntax(cleaned), false);
  assert.match(cleaned, /Let me check Sentry\./);
  assert.match(cleaned, /comes from src\/pricing\.js\./);
  assert.doesNotMatch(cleaned, /Found 1 issue/);
});

test("strips a block whose opening tag has attributes, body and all", () => {
  const cleaned = stripToolProtocolSyntax('Sure. <tool_call type="text">{"name":"x"}</tool_call> Done.');
  assert.doesNotMatch(cleaned, /"name"/);
  assert.match(cleaned, /Sure\..*Done\./);
});

test("strips stray, unbalanced tags", () => {
  assert.equal(stripToolProtocolSyntax("Here you go: <tool_response> partial"), "Here you go:  partial");
});

test("leaves clean text alone", () => {
  const clean = "The annual plan has no seat tiers.";
  assert.equal(stripToolProtocolSyntax(clean), clean);
});
