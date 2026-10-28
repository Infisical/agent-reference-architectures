import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const base = {
  SLACK_BOT_TOKEN: "xoxb",
  SLACK_APP_TOKEN: "xapp",
  SPACE_API_URL: "http://localhost:8080",
  SPACE_DATA_PLANE_URL: "http://localhost:8090",
  SPACE_API_TOKEN: "t",
  INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "id",
  INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "secret",
  AGENT_VAULT_ACCESS_BUNDLE: "coding-agent",
  AGENT_VAULT_PROXY_ADDRESS: "10.0.0.5:17323",
  AGENT_VAULT_CA_FINGERPRINT: "SHA256:AA:BB",
};

test("defaults for everything optional", () => {
  const config = loadConfig(base);
  assert.equal(config.space.template, "coding-agent:v1");
  assert.equal(config.vault.domain, "https://app.infisical.com");
  assert.equal(config.maxSandboxes, 3);
  assert.equal(config.runTimeoutMs, 600_000);
  assert.equal(config.stateDir, "state");
  assert.deepEqual(config.space.networkPolicy.egress.allow, [{ ip: "10.0.0.5" }], "sandboxes may reach only the proxy");
});

test("lists every missing variable at once", () => {
  assert.throws(() => loadConfig({}), /SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SPACE_API_URL.*AGENT_VAULT_PROXY_ADDRESS/);
});

test("slack: false skips the Slack variables and the CA pin, for the smoke test", () => {
  const { SLACK_BOT_TOKEN, SLACK_APP_TOKEN, AGENT_VAULT_CA_FINGERPRINT, ...rest } = base;
  assert.doesNotThrow(() => loadConfig(rest, { slack: false }));
});

test("the bot refuses to start without a pinned proxy CA", () => {
  const { AGENT_VAULT_CA_FINGERPRINT, ...rest } = base;
  assert.throws(() => loadConfig(rest), /Missing required environment variables: AGENT_VAULT_CA_FINGERPRINT/);
});

test("rejects a non-numeric limit", () => {
  assert.throws(() => loadConfig({ ...base, MAX_SANDBOXES: "many" }), /MAX_SANDBOXES must be a positive integer/);
});
