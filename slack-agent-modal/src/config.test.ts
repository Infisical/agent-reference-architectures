import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const base = {
  SLACK_BOT_TOKEN: "xoxb",
  SLACK_APP_TOKEN: "xapp",
  MODAL_TOKEN_ID: "ak-id",
  MODAL_TOKEN_SECRET: "as-secret",
  INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "id",
  INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "secret",
  AGENT_VAULT_ACCESS_BUNDLE: "coding-agent",
  AGENT_VAULT_PROXY_VOLUME: "agent-proxy-state",
  AGENT_VAULT_CA_FINGERPRINT: "SHA256:AA:BB",
};

test("defaults for everything optional", () => {
  const config = loadConfig(base);
  assert.equal(config.modal.appName, "apollo");
  assert.equal(config.modal.image, "builtin");
  assert.equal(config.modal.environment, undefined);
  assert.equal(config.modal.cpu, 2);
  assert.equal(config.modal.memoryMiB, 2048);
  assert.equal(config.vault.domain, "https://app.infisical.com");
  assert.equal(config.maxSandboxes, 3);
  assert.equal(config.runTimeoutMs, 600_000);
  assert.equal(config.stateDir, "state");
  assert.deepEqual(config.vault.proxy, { volume: "agent-proxy-state" });
});

test("lists every missing variable at once", () => {
  assert.throws(() => loadConfig({}), /SLACK_BOT_TOKEN, SLACK_APP_TOKEN, MODAL_TOKEN_ID, MODAL_TOKEN_SECRET.*AGENT_VAULT_PROXY_VOLUME \(or AGENT_VAULT_PROXY_ADDRESS\)/);
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

test("sandbox CPU may be fractional; memory may not", () => {
  assert.equal(loadConfig({ ...base, MODAL_SANDBOX_CPU: "0.5" }).modal.cpu, 0.5);
  assert.throws(() => loadConfig({ ...base, MODAL_SANDBOX_MEMORY_MIB: "1.5" }), /MODAL_SANDBOX_MEMORY_MIB must be a positive integer/);
});

test("a fixed proxy outside Modal is its address alone", () => {
  const { AGENT_VAULT_PROXY_VOLUME, ...rest } = base;
  assert.deepEqual(loadConfig({ ...rest, AGENT_VAULT_PROXY_ADDRESS: "203.0.113.7:17323" }).vault.proxy, { address: "203.0.113.7:17323" });
});

test("the proxy is set one way, not both", () => {
  assert.throws(() => loadConfig({ ...base, AGENT_VAULT_PROXY_ADDRESS: "203.0.113.7:17323" }), /not both/);
});
