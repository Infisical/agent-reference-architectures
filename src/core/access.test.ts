import { test } from "node:test";
import assert from "node:assert/strict";

// access.ts reads AGENT_ALLOWLIST once at import, so set it before importing.
process.env.AGENT_ALLOWLIST = "Alex@Example.com, robin@example.com  morgan@example.com";
const { isAllowedEmail, allowlistConfigured } = await import("./access.ts");

test("allowlist is configured when the env var has entries", () => {
  assert.equal(allowlistConfigured(), true);
});

test("allows listed emails, case- and whitespace-insensitively", () => {
  assert.equal(isAllowedEmail("alex@example.com"), true);
  assert.equal(isAllowedEmail("ALEX@EXAMPLE.COM"), true);
  assert.equal(isAllowedEmail("  robin@example.com "), true);
  // comma- and space-separated entries both parse
  assert.equal(isAllowedEmail("morgan@example.com"), true);
});

test("denies unlisted, empty, and missing emails (fails closed)", () => {
  assert.equal(isAllowedEmail("stranger@example.com"), false);
  assert.equal(isAllowedEmail(""), false);
  assert.equal(isAllowedEmail(undefined), false);
  assert.equal(isAllowedEmail(null), false);
});
