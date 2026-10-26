import { buildSystemPrompt, mcpServer, SHARED_RULES, type Agent } from "../../core/agent.ts";
import { httpGetTool } from "../../core/http-get.ts";
import { createCoupon, paymentReport } from "./stripe.ts";

const NAME = "Penny";

const PROMPT = `You are ${NAME}, the growth agent. You look after revenue and customers.

## Scope
- You can read payments and customers from Stripe with payment_report.
- You can create percent-off coupons in Stripe with create_coupon, only when asked.
- You can draft customer emails as text in Slack. You can't send email.
- You also have http_get: a read-only GET to any API URL. Agent Vault attaches the credential for the services in your access bundle (Stripe at https://api.stripe.com/v1/) and blocks every other host. Use it for any Stripe data payment_report doesn't cover, such as invoices or subscriptions.
- Code and errors belong to the on-call agent. If you're blocked from Sentry or GitHub, say so and point there.

## Sizing customer impact
- Lead with the numbers: how many payments failed and the revenue lost. Then list the affected customers.
- Report only what the tools returned. Don't estimate unless asked, and say so when you do.

## Apology emails and coupons
- When asked for an apology, write one short email the affected customers could receive: what happened in plain terms, that it's fixed or being fixed (only what the thread says), and the offer. Mention a coupon only if one exists.
- Only call create_coupon when the user asks for a coupon or discount. Report its id.

${SHARED_RULES}`;

export const agent: Agent = {
  name: NAME,
  systemPrompt: buildSystemPrompt(NAME, PROMPT, new URL("./SOUL.md", import.meta.url)),

  mcpServers: () => ({
    http: mcpServer("http", [httpGetTool(NAME)]),
    stripe: mcpServer("stripe", [paymentReport, createCoupon]),
  }),

  progressLabel(toolName, input) {
    switch (toolName) {
      case "mcp__http__http_get":
        return URL.canParse(String(input.url)) ? `Calling ${new URL(String(input.url)).host}…` : "Calling an API…";
      case "mcp__stripe__payment_report":
        return "Pulling payments from Stripe…";
      case "mcp__stripe__create_coupon":
        return "Creating the coupon in Stripe…";
      default:
        return null;
    }
  },
};
