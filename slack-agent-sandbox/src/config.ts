import { proxyOnlyEgressPolicy, type EgressPolicy } from "./space.js";

/** Everything Atlas reads from the environment, checked once at startup. */
export interface Config {
  slack: { botToken: string; appToken: string; allowlist: string };
  space: {
    apiUrl: string;
    dataPlaneUrl: string;
    apiToken: string;
    caFile?: string;
    template: string;
    /** Derived from the proxy address: each sandbox may reach Agent Proxy and nothing else. */
    networkPolicy: EgressPolicy;
  };
  vault: {
    domain: string;
    clientId: string;
    clientSecret: string;
    /** The bundle every run gets in v1, until bundles are chosen per Slack user. */
    defaultAccessBundle: string;
    proxyAddress: string;
    /** The proxy CA's SHA256 fingerprint, pinned in each sandbox. Always set for the bot. */
    caFingerprint?: string;
  };
  model?: string;
  maxSandboxes: number;
  runTimeoutMs: number;
  stateDir: string;
  port: number;
}

/**
 * Reads the config, failing with every missing variable at once. `slack: false` is for the
 * smoke test, which runs a sandbox without Slack.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, { slack = true } = {}): Config {
  const missing: string[] = [];
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) missing.push(name);
    return value ?? "";
  };
  const optional = (name: string) => env[name]?.trim() || undefined;
  const positiveInt = (name: string, fallback: number) => {
    const raw = optional(name);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
    return value;
  };

  // Read in this order so missing variables are listed in it.
  const slackConfig = slack
    ? { botToken: required("SLACK_BOT_TOKEN"), appToken: required("SLACK_APP_TOKEN"), allowlist: env.SLACK_ALLOWLIST ?? "" }
    : { botToken: "", appToken: "", allowlist: "" };
  const space = {
    apiUrl: required("SPACE_API_URL"),
    dataPlaneUrl: required("SPACE_DATA_PLANE_URL"),
    apiToken: required("SPACE_API_TOKEN"),
    caFile: optional("SPACE_CA_FILE"),
    template: optional("SPACE_TEMPLATE") ?? "coding-agent:v1",
  };
  const vault = {
    domain: optional("INFISICAL_DOMAIN") ?? "https://app.infisical.com",
    clientId: required("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID"),
    clientSecret: required("INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET"),
    defaultAccessBundle: required("AGENT_VAULT_ACCESS_BUNDLE"),
    proxyAddress: required("AGENT_VAULT_PROXY_ADDRESS"),
    // Required for the bot, which runs unattended: without it a sandbox trusts whatever CA answers
    // at the proxy address. Optional for the smoke test, which checks the pin itself.
    caFingerprint: slack ? required("AGENT_VAULT_CA_FINGERPRINT") : optional("AGENT_VAULT_CA_FINGERPRINT"),
  };

  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  const config: Config = {
    slack: slackConfig,
    space: { ...space, networkPolicy: proxyOnlyEgressPolicy(vault.proxyAddress) },
    vault,
    model: optional("HARNESS_MODEL"),
    maxSandboxes: positiveInt("MAX_SANDBOXES", 3),
    runTimeoutMs: positiveInt("RUN_TIMEOUT_MS", 10 * 60 * 1000),
    stateDir: optional("STATE_DIR") ?? "state",
    port: positiveInt("PORT", 3000),
  };

  return config;
}
