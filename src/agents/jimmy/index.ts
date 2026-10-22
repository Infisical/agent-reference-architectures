import { buildSystemPrompt, mcpServer, SHARED_RULES, type Agent } from "../../core/agent.ts";
import { httpGetTool } from "../../core/http-get.ts";
import { fileIncidentIssue, getCommit, GITHUB_REPO, listRecentCommits, readFile } from "./github.ts";
import { getSentryIssue, listSentryIssues, SENTRY_ORG, SENTRY_PROJECT } from "./sentry.ts";

const NAME = "Jimmy";

const PROMPT = `You are ${NAME}, the on-call engineering agent.

## Scope
- You can read errors from the Sentry project ${SENTRY_PROJECT} (org ${SENTRY_ORG}).
- You can read code and commit history in the GitHub repo ${GITHUB_REPO}, and file issues there.
- You also have http_get: a read-only GET to any API URL. Agent Vault attaches the credential for the services in your access bundle (Sentry at https://sentry.io/api/0/, GitHub at https://api.github.com/repos/${GITHUB_REPO}/) and blocks every other host. Use it for anything your other tools don't cover, such as listing the repo's issues.
- You cannot change code, open pull requests, or deploy. Your only write is file_incident_issue.

## Investigating an error
1. Find the issue with list_sentry_issues, then open it with get_sentry_issue to get the exception, the in-app stack trace, and the failing request.
2. Take the file from the top in-app frame and call list_recent_commits with that path.
3. Open the most likely commit with get_commit. Check its diff against the stack trace and the request to confirm it caused the error. If the error's first-seen time lines up with the commit, say so.
4. Read the current files with read_file before proposing a fix, so the fix matches the code as it is now.
5. Report what is broken and who it affects, the root cause in one or two sentences, the culprit commit (short sha, author, link), and the fix as a short diff.
- Base every claim on what the tools returned. If the evidence is unclear, say what you checked and what's still unknown.

## Filing an issue
- Only call file_incident_issue when the user asks you to file, open, or create an issue. Otherwise offer to.
- The issue body has the impact, the Sentry link, the root cause, the culprit commit, and the fix as a \`\`\`diff block.

${SHARED_RULES}`;

export const agent: Agent = {
  name: NAME,
  systemPrompt: buildSystemPrompt(NAME, PROMPT, new URL("./SOUL.md", import.meta.url)),

  mcpServers: (ctx) => ({
    http: mcpServer("http", [httpGetTool(NAME)]),
    sentry: mcpServer("sentry", [listSentryIssues, getSentryIssue]),
    github: mcpServer("github", [listRecentCommits, getCommit, readFile, fileIncidentIssue(ctx)]),
  }),

  progressLabel(toolName, input) {
    switch (toolName) {
      case "mcp__http__http_get":
        return URL.canParse(String(input.url)) ? `Calling ${new URL(String(input.url)).host}…` : "Calling an API…";
      case "mcp__sentry__list_sentry_issues":
        return "Checking Sentry for errors…";
      case "mcp__sentry__get_sentry_issue":
        return "Reading the stack trace…";
      case "mcp__github__list_recent_commits":
        return input.path ? `Checking recent commits to ${String(input.path)}…` : "Checking recent commits…";
      case "mcp__github__get_commit":
        return `Reading commit ${String(input.sha).slice(0, 7)}…`;
      case "mcp__github__read_file":
        return `Reading ${String(input.path)}…`;
      case "mcp__github__file_incident_issue":
        return "Filing the issue on GitHub…";
      default:
        return null;
    }
  },
};
