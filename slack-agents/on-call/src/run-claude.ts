import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseStreamLine, progressLabel } from "./claude-stream.ts";
import type { Agent } from "./config.ts";

const MODEL = process.env.AGENT_MODEL?.trim() || "claude-sonnet-5-5";
const TIMEOUT_MS = 20 * 60_000;

// Runs share one working directory, so they run one at a time.
let queue: Promise<unknown> = Promise.resolve();

export function runClaude(agent: Agent, prompt: string, onProgress?: (label: string) => void): Promise<string> {
  const run = queue.then(() => runOnce(agent, prompt, onProgress));
  queue = run.catch(() => {});
  return run;
}

async function runOnce(agent: Agent, prompt: string, onProgress?: (label: string) => void): Promise<string> {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", MODEL,
    "--permission-mode", "bypassPermissions",
    ...(agent.mcpConfigFile ? ["--mcp-config", agent.mcpConfigFile] : []),
    "--strict-mcp-config",
    "--append-system-prompt", readFileSync(agent.promptFile, "utf8"),
  ];

  const child = spawn("claude", args, {
    cwd: agent.workdir,
    env: {
      ...process.env,
      // Telemetry and update checks go to hosts outside the access bundle, which the proxy refuses.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  // Without these handlers, a failed start or an early exit crashes the bridge.
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  exited.catch(() => {});
  child.stdin.on("error", () => {});
  // On stdin, because a long Slack thread can outgrow the limit on one argument.
  child.stdin.end(prompt);

  const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
  let answer: { text: string; isError: boolean } | undefined;
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const event = parseStreamLine(line);
      if (event.kind === "tool") {
        const label = progressLabel(event.tool);
        if (label) onProgress?.(label);
      } else if (event.kind === "result") {
        answer = event;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const code = await exited;

  if (!answer || answer.isError) {
    throw new Error(`Claude Code finished without an answer (exit ${code})${answer?.text ? `: ${answer.text}` : ""}`);
  }
  return answer.text;
}
