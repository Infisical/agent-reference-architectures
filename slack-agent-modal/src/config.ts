import { BUILTIN_IMAGE } from "./image.js";

/**
 * Where sandboxes find Agent Proxy (modal.ts proxyFor): a sidecar in every sandbox, started from
 * the enrollment on a Modal Volume (proxy/agent_proxy.py writes it), or a fixed IPv4 `host:port`
 * for a proxy outside Modal.
 */
export type ProxyConfig = { volume: string } | { address: string };

/** Everything Apollo reads from the environment, checked once at startup. */
export interface Config {
  slack: { botToken: string; appToken: string; allowlist: string };
  modal: {
    tokenId: string;
    tokenSecret: string;
    environment?: string;
    appName: string;
    /** MODAL_IMAGE: `builtin`, an image ID or a published image name (image.ts resolveImage). */
    image: string;
    cpu: number;
    memoryMiB: number;
  };
  vault: {
    domain: string;
    clientId: string;
    clientSecret: string;
    /** The bundle every run gets in v1, until bundles are chosen per Slack user. */
    defaultAccessBundle: string;
    proxy: ProxyConfig;
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
  const positive = (name: string, fallback: number, { integer = true } = {}) => {
    const raw = optional(name);
    const value = raw === undefined ? fallback : Number(raw);
    if (!(value > 0) || (integer && !Number.isInteger(value))) {
      throw new Error(`${name} must be a positive ${integer ? "integer" : "number"}, got "${raw}"`);
    }
    return value;
  };
  const positiveInt = (name: string, fallback: number) => positive(name, fallback);
  /** Exactly one of the proxy variables. */
  const proxy = (): ProxyConfig => {
    const volume = optional("AGENT_VAULT_PROXY_VOLUME");
    const address = optional("AGENT_VAULT_PROXY_ADDRESS");
    if (volume && address) throw new Error("Set AGENT_VAULT_PROXY_VOLUME or AGENT_VAULT_PROXY_ADDRESS, not both");
    if (volume) return { volume };
    if (address) return { address };
    missing.push("AGENT_VAULT_PROXY_VOLUME (or AGENT_VAULT_PROXY_ADDRESS)");
    // Never used: the missing variable is reported before the config is returned.
    return { address: "" };
  };

  // Read in this order so missing variables are listed in it.
  const slackConfig = slack
    ? { botToken: required("SLACK_BOT_TOKEN"), appToken: required("SLACK_APP_TOKEN"), allowlist: env.SLACK_ALLOWLIST ?? "" }
    : { botToken: "", appToken: "", allowlist: "" };
  const modal = {
    tokenId: required("MODAL_TOKEN_ID"),
    tokenSecret: required("MODAL_TOKEN_SECRET"),
    environment: optional("MODAL_ENVIRONMENT"),
    appName: optional("MODAL_APP_NAME") ?? "apollo",
    image: optional("MODAL_IMAGE") ?? BUILTIN_IMAGE,
  };
  const vault = {
    domain: optional("INFISICAL_DOMAIN") ?? "https://app.infisical.com",
    clientId: required("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID"),
    clientSecret: required("INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET"),
    defaultAccessBundle: required("AGENT_VAULT_ACCESS_BUNDLE"),
    proxy: proxy(),
    // Required for the bot, which runs unattended: without it a sandbox trusts whatever CA answers
    // at the proxy address. Optional for the smoke test, which checks the pin itself.
    caFingerprint: slack ? required("AGENT_VAULT_CA_FINGERPRINT") : optional("AGENT_VAULT_CA_FINGERPRINT"),
  };

  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  const config: Config = {
    slack: slackConfig,
    modal: {
      ...modal,
      cpu: positive("MODAL_SANDBOX_CPU", 2, { integer: false }),
      memoryMiB: positiveInt("MODAL_SANDBOX_MEMORY_MIB", 2048),
    },
    vault,
    model: optional("HARNESS_MODEL"),
    maxSandboxes: positiveInt("MAX_SANDBOXES", 3),
    runTimeoutMs: positiveInt("RUN_TIMEOUT_MS", 10 * 60 * 1000),
    stateDir: optional("STATE_DIR") ?? "state",
    port: positiveInt("PORT", 3000),
  };

  return config;
}
