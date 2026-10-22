// Stripe tools. STRIPE_API_KEY is a placeholder; Agent Vault attaches the real restricted key.
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { requireEnv } from "../../core/config.ts";
import { runTool, text } from "../../core/tool-result.ts";

const MAX_PAGES = 5;

async function stripeRequest<T>(method: "GET" | "POST", path: string, params = new URLSearchParams()): Promise<T> {
  const query = method === "GET" && params.size ? `?${params}` : "";
  const response = await fetch(`https://api.stripe.com/v1${path}${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${requireEnv("STRIPE_API_KEY")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: method === "POST" ? params.toString() : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Stripe API error: ${response.status} ${response.statusText}. ${body.slice(0, 500)}`);
  }
  return response.json() as Promise<T>;
}

interface PaymentIntent {
  id: string;
  amount: number;
  currency: string;
  status: string;
  created: number;
  description: string | null;
  cancellation_reason: string | null;
  last_payment_error: { message?: string } | null;
  customer: null | string | { id: string; name?: string | null; email?: string | null };
}

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

export const paymentReport = tool(
  "payment_report",
  "Summarize recent Stripe payments: how many succeeded and failed, the revenue from each, and every customer whose payment failed (name, email, amount, reason).",
  {
    sinceHours: z.number().int().min(1).max(720).optional().describe("Look-back window in hours. Defaults to 168 (7 days)."),
  },
  async (args) =>
    runTool("I couldn't reach Stripe just now. Try again in a moment.", async () => {
      const hours = args.sinceHours ?? 168;
      const since = Math.floor(Date.now() / 1000) - hours * 3600;

      const intents: PaymentIntent[] = [];
      let startingAfter: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({ limit: "100", "created[gte]": String(since), "expand[]": "data.customer" });
        if (startingAfter) params.set("starting_after", startingAfter);
        const res = await stripeRequest<{ data: PaymentIntent[]; has_more: boolean }>("GET", "/payment_intents", params);
        intents.push(...res.data);
        if (!res.has_more || !res.data.length) break;
        startingAfter = res.data.at(-1)!.id;
      }
      if (!intents.length) return text(`No payments in the last ${hours}h.`);

      const totals = new Map<string, { succeeded: number; succeededCents: number; failed: number; failedCents: number }>();
      const failed: string[] = [];
      for (const pi of intents) {
        const t = totals.get(pi.currency) ?? { succeeded: 0, succeededCents: 0, failed: 0, failedCents: 0 };
        if (pi.status === "succeeded") {
          t.succeeded += 1;
          t.succeededCents += pi.amount;
        } else if (pi.status === "canceled" || pi.status === "requires_payment_method") {
          t.failed += 1;
          t.failedCents += pi.amount;
          const c = typeof pi.customer === "object" ? pi.customer : null;
          const reason = pi.last_payment_error?.message ?? pi.cancellation_reason ?? pi.status;
          failed.push(
            `- ${c?.name ?? "unknown"} <${c?.email ?? "no email"}> · ${money(pi.amount, pi.currency)} · ${new Date(pi.created * 1000).toISOString()} · ${reason}${pi.description ? ` · ${pi.description}` : ""} · customer ${c?.id ?? "none"}`,
          );
        }
        totals.set(pi.currency, t);
      }

      const out = [`Payments in the last ${hours}h (${intents.length} total, others still in progress):`];
      for (const [currency, t] of totals) {
        out.push(
          `- ${currency.toUpperCase()}: ${t.succeeded} succeeded (${money(t.succeededCents, currency)}), ${t.failed} failed (${money(t.failedCents, currency)} lost)`,
        );
      }
      if (failed.length) out.push(`\nFailed payments (${failed.length}):`, ...failed);
      return text(out.join("\n"));
    }, "Stripe error:"),
);

export const createCoupon = tool(
  "create_coupon",
  "Create a percent-off coupon in Stripe, for example to make good with customers hit by an outage. Only call this when the user asks for a coupon or discount. Call it once per request.",
  {
    name: z.string().min(1).max(40).describe('Customer-facing name, e.g. "Sorry about checkout".'),
    percentOff: z.number().min(1).max(100).describe("Percent discount, e.g. 20."),
    duration: z.enum(["once", "repeating", "forever"]).describe("How long the discount applies."),
    durationInMonths: z.number().int().min(1).max(36).optional().describe('Required when duration is "repeating".'),
  },
  async (args) =>
    runTool("I couldn't reach Stripe just now, so I didn't create the coupon.", async () => {
      if (args.duration === "repeating" && !args.durationInMonths) {
        return text("A repeating coupon needs durationInMonths. Ask how many months it should last.");
      }
      const params = new URLSearchParams({
        name: args.name,
        percent_off: String(args.percentOff),
        duration: args.duration,
        "metadata[created_by]": "penny-agent",
      });
      if (args.durationInMonths) params.set("duration_in_months", String(args.durationInMonths));
      const coupon = await stripeRequest<{ id: string; name: string; percent_off: number; duration: string }>("POST", "/coupons", params);
      console.log(`[stripe] created coupon ${coupon.id}`);
      return text(
        `Created coupon ${coupon.id}: "${coupon.name}", ${coupon.percent_off}% off, ${coupon.duration}${args.durationInMonths ? ` for ${args.durationInMonths} months` : ""}.`,
      );
    }, "Stripe error:"),
);
