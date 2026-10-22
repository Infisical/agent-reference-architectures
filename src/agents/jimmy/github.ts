// GitHub tools for one repo. The repo comes from env, never from the model, so these tools only
// touch that repo. http_get can still reach anything the token can, so use a token scoped to this
// one repo. GITHUB_TOKEN is a placeholder; Agent Vault attaches the real one.
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { RequestContext } from "../../core/agent.ts";
import { requireEnv } from "../../core/config.ts";
import { runTool, text } from "../../core/tool-result.ts";

export const GITHUB_REPO = requireEnv("GITHUB_REPO");
const MAX_PATCH_CHARS = 6_000;
const MAX_FILE_CHARS = 12_000;

async function githubFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${requireEnv("GITHUB_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jimmy-agent",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}. ${body.slice(0, 500)}`);
  }
  return response.json() as Promise<T>;
}

/** Encodes each segment of a repo path, and rejects "." and ".." so the path stays inside the repo. */
function encodePath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === "..")) throw new Error(`Invalid path: ${path}`);
  return segments.map(encodeURIComponent).join("/");
}

interface Commit {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name: string; email: string; date: string } };
  files?: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>;
}

export const listRecentCommits = tool(
  "list_recent_commits",
  `List recent commits on the default branch of ${GITHUB_REPO}, newest first. Pass a file path to see only commits that touched that file.`,
  {
    path: z.string().optional().describe('Repo-relative file path, e.g. "src/pricing.js".'),
    limit: z.number().int().min(1).max(30).optional().describe("How many commits. Defaults to 10."),
  },
  async (args) =>
    runTool("I couldn't reach GitHub just now. Try again in a moment.", async () => {
      const params = new URLSearchParams({ per_page: String(args.limit ?? 10) });
      if (args.path) params.set("path", args.path.replace(/^\/+/, ""));
      const commits = await githubFetch<Commit[]>(`/commits?${params}`);
      if (!commits.length) return text("No commits found.");
      const lines = commits.map(
        (c) =>
          `- ${c.sha.slice(0, 7)} ${c.commit.author.date} ${c.commit.author.name}: ${c.commit.message.split("\n")[0]}\n  ${c.html_url}`,
      );
      return text(lines.join("\n"));
    }, "GitHub error:"),
);

export const getCommit = tool(
  "get_commit",
  `Show one commit in ${GITHUB_REPO}: message, author, date, and the diff of every file it changed.`,
  {
    sha: z.string().min(4).describe("Full or short commit sha."),
  },
  async (args) =>
    runTool("I couldn't load that commit just now. Try again in a moment.", async () => {
      const c = await githubFetch<Commit>(`/commits/${encodeURIComponent(args.sha)}`);
      const out = [
        `${c.sha.slice(0, 7)} by ${c.commit.author.name} <${c.commit.author.email}> on ${c.commit.author.date}`,
        `message: ${c.commit.message}`,
        `link: ${c.html_url}`,
      ];
      for (const f of c.files ?? []) {
        out.push(`\n--- ${f.filename} (${f.status}, +${f.additions} -${f.deletions})`);
        if (f.patch) out.push(f.patch.slice(0, MAX_PATCH_CHARS));
      }
      return text(out.join("\n"));
    }, "GitHub error:"),
);

export const readFile = tool(
  "read_file",
  `Read a file from ${GITHUB_REPO}, on the default branch or at a specific commit.`,
  {
    path: z.string().describe('Repo-relative file path, e.g. "src/plans.js".'),
    ref: z.string().optional().describe("Commit sha or branch. Defaults to the default branch."),
  },
  async (args) =>
    runTool("I couldn't read that file just now. Try again in a moment.", async () => {
      const ref = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : "";
      const file = await githubFetch<{ type: string; content?: string }>(`/contents/${encodePath(args.path)}${ref}`);
      if (file.type !== "file" || !file.content) return text(`${args.path} is not a readable file.`);
      const numbered = Buffer.from(file.content, "base64")
        .toString("utf8")
        .split("\n")
        .map((line, i) => `${String(i + 1).padStart(4)}: ${line}`)
        .join("\n");
      return text(`${args.path}${args.ref ? ` @ ${args.ref}` : ""}\n${numbered.slice(0, MAX_FILE_CHARS)}`);
    }, "GitHub error:"),
);

/** Built per request so the issue records who asked and links back to their Slack thread. */
export function fileIncidentIssue(ctx: RequestContext) {
  return tool(
    "file_incident_issue",
    `File a GitHub issue in ${GITHUB_REPO} for an incident you investigated. Only call this when the user asks you to file, open, or create an issue. Call it once per request.`,
    {
      title: z.string().min(1).describe("Short, specific title naming the symptom and cause."),
      body: z
        .string()
        .min(1)
        .describe("GitHub Markdown: impact, the Sentry link, root cause with the culprit commit sha and link, and the proposed fix as a ```diff block."),
    },
    async (args) =>
      runTool("The request to GitHub failed, so I don't know whether the issue was created. Check the repo's issues before trying again.", async () => {
        const thread = ctx.threadUrl ? ` in [this Slack thread](${ctx.threadUrl})` : "";
        const issue = await githubFetch<{ number: number; html_url: string }>("/issues", {
          method: "POST",
          body: JSON.stringify({
            title: args.title,
            body: `${args.body}\n\n---\n_Filed by Jimmy from Slack. Requested by ${ctx.requesterName}${thread}._`,
          }),
        });
        console.log(`[github] created issue #${issue.number}`);
        return text(`Filed issue #${issue.number}: ${issue.html_url}`);
      }, "GitHub error:"),
  );
}
