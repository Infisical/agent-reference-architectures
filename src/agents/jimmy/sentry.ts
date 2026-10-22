// Read-only Sentry tools. The org and project come from env, never from the model, so the agent
// can't look anywhere else. SENTRY_AUTH_TOKEN is a placeholder; Agent Vault attaches the real one.
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { requireEnv } from "../../core/config.ts";
import { runTool, text } from "../../core/tool-result.ts";

const API_BASE = "https://sentry.io/api/0";
export const SENTRY_ORG = requireEnv("SENTRY_ORG");
export const SENTRY_PROJECT = requireEnv("SENTRY_PROJECT");

async function sentryGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${requireEnv("SENTRY_AUTH_TOKEN")}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Sentry API error: ${response.status} ${response.statusText}. ${body.slice(0, 500)}`);
  }
  return response.json() as Promise<T>;
}

interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  count: string;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  status: string;
}

interface Frame {
  filename?: string;
  function?: string;
  lineNo?: number;
  inApp?: boolean;
  context?: Array<[number, string]>;
}

interface SentryEvent {
  entries: Array<{ type: string; data: any }>;
  tags?: Array<{ key: string; value: string }>;
}

export const listSentryIssues = tool(
  "list_sentry_issues",
  `List error issues in the ${SENTRY_PROJECT} Sentry project, most recent first. Use this to see what is breaking right now.`,
  {
    query: z.string().optional().describe('Sentry search query. Defaults to "is:unresolved".'),
    period: z.string().optional().describe('Time window such as "24h" or "14d". Defaults to "14d".'),
  },
  async (args) =>
    runTool("I couldn't reach Sentry just now. Try again in a moment.", async () => {
      const params = new URLSearchParams({
        query: args.query ?? "is:unresolved",
        statsPeriod: args.period ?? "14d",
        sort: "date",
        limit: "10",
      });
      const issues = await sentryGet<SentryIssue[]>(`/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/issues/?${params}`);
      if (!issues.length) return text("No matching Sentry issues in that window.");
      const lines = issues.map(
        (i) =>
          `- ${i.shortId} (id ${i.id}): ${i.title}\n  culprit: ${i.culprit}\n  events: ${i.count}, users: ${i.userCount}, first seen: ${i.firstSeen}, last seen: ${i.lastSeen}\n  link: ${i.permalink}`,
      );
      return text(lines.join("\n"));
    }, "Sentry error:"),
);

export const getSentryIssue = tool(
  "get_sentry_issue",
  "Get one Sentry issue in detail: the latest event's exception, in-app stack trace with source context, the failing request, and tags. Use this to find the file and line that broke.",
  {
    issueId: z.string().describe("The numeric issue id from list_sentry_issues, not the short id."),
  },
  async (args) =>
    runTool("I couldn't load that Sentry issue just now. Try again in a moment.", async () => {
      const issue = await sentryGet<SentryIssue>(`/organizations/${SENTRY_ORG}/issues/${args.issueId}/`);
      const event = await sentryGet<SentryEvent>(`/organizations/${SENTRY_ORG}/issues/${args.issueId}/events/latest/`);

      const out = [
        `${issue.shortId}: ${issue.title}`,
        `status: ${issue.status}, events: ${issue.count}, users: ${issue.userCount}`,
        `first seen: ${issue.firstSeen}, last seen: ${issue.lastSeen}`,
        `link: ${issue.permalink}`,
      ];

      for (const entry of event.entries) {
        if (entry.type === "exception") {
          for (const value of entry.data?.values ?? []) {
            out.push(`\nException: ${value.type}: ${value.value}`);
            const frames: Frame[] = value.stacktrace?.frames ?? [];
            const inApp = frames.filter((f) => f.inApp);
            for (const f of (inApp.length ? inApp : frames).slice(-6).reverse()) {
              // Sentry's rewriteFrames integration reports paths as app:///src/...; strip the prefix so
              // the path matches the repo and can go straight to list_recent_commits.
              const file = f.filename?.replace(/^app:\/\/\//, "");
              out.push(`  at ${f.function ?? "<anonymous>"} (${file}:${f.lineNo})`);
              for (const [n, line] of f.context ?? []) out.push(`    ${n === f.lineNo ? ">" : " "} ${n}: ${line}`);
            }
          }
        }
        if (entry.type === "request") {
          const d = entry.data ?? {};
          out.push(`\nRequest: ${d.method} ${d.url}`);
          if (d.data) out.push(`  body: ${JSON.stringify(d.data).slice(0, 500)}`);
        }
      }

      const tags = (event.tags ?? []).map((t) => `${t.key}=${t.value}`).join(", ");
      if (tags) out.push(`\nTags: ${tags}`);
      return text(out.join("\n"));
    }, "Sentry error:"),
);
