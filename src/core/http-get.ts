import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { runTool, text } from "./tool-result.ts";

const MAX_BODY_CHARS = 12_000;
const REQUEST_TIMEOUT_MS = 15_000;

// A read-only GET to any URL the model picks. It never attaches a credential. The Agent Vault proxy
// decides per request: for a host in this agent's access bundle it attaches the real credential,
// and for any other host it answers 403 "host blocked by policy". So the proxy, not this code or
// the prompt, is what limits where the agent can go.
export function httpGetTool(agentName: string) {
  return tool(
    "http_get",
    "Make a read-only HTTPS GET request to any API URL and get the status and response body. Agent Vault attaches credentials for the services you're allowed to use, so never add tokens yourself. Use this for anything your other tools don't cover, and to try any system you're asked about, even one you may not have access to.",
    {
      url: z.string().url().describe("Full https URL, including any query string."),
    },
    async (args) =>
      runTool("The request failed before it got a response. Try again in a moment.", async () => {
        const url = new URL(args.url);
        if (url.protocol !== "https:") return text("Only https URLs are allowed.");
        // Slack's Web API accepts GET for write methods like chat.postMessage, and the Slack service
        // is in every access bundle, so a GET there isn't read-only. The bot's own code talks to Slack.
        const host = url.hostname.replace(/\.$/, "");
        if (host === "slack.com" || host.endsWith(".slack.com")) {
          return text("http_get can't call Slack. Slack is only reachable through the bot itself.");
        }

        const response = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": `${agentName.toLowerCase()}-agent` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const body = await response.text();

        if (response.status === 403 && body.includes("blocked by policy")) {
          console.log(`[http_get] blocked by Agent Vault: ${url.host}`);
          return text(
            `BLOCKED by Agent Vault. The proxy refused this request before it left: ${body.trim()}. ${url.host} is not in this agent's access bundle, so no credential exists for it here.`,
          );
        }

        console.log(`[http_get] ${response.status} ${url.host}${url.pathname}`);
        const truncated = body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n…(truncated)` : body;
        return text(`HTTP ${response.status}\n${truncated}`);
      }, "http_get error:"),
  );
}
