/**
 * Harness-neutral events; handler.ts decides how they look in Slack. Only `final` is required:
 * an adapter emits the others when its CLI reports them, and Slack shows whatever it gets.
 */
export type HarnessEvent =
  /** A tool call. `detail` is a short human-readable summary of what it acts on. */
  | { type: "tool"; name?: string; detail?: string }
  /**
   * Text the agent wrote, emitted as it arrives. The handler shows it only alongside a later tool
   * call, so text that turns out to be the final answer never appears as progress.
   */
  | { type: "narration"; text: string }
  | { type: "final"; text: string; stats?: AgentStats };

/** What the CLI reports about its own run, when it does; logged with the run's timings. */
export interface AgentStats {
  /** The agent's own wall time, from its start to its answer. */
  durationMs?: number;
  /** Of that, time spent waiting on the model API. */
  apiMs?: number;
  turns?: number;
}

export interface CommandOptions {
  /** File in the VM holding the agent's instructions (instructions/AGENTS.md). */
  instructionsPath: string;
}

/**
 * An agent CLI that runs inside a Modal Sandbox. run.ts drives the sandbox lifecycle and never
 * looks inside: it runs `command()` under `infisical agent-vault run`, feeds it the prompt on
 * stdin, and hands each stdout line to `parseLine`. Adding a CLI means adding one adapter.
 */
export interface Harness {
  name: string;
  /** Sandbox image with this CLI installed: a MODAL_IMAGE reference (image.ts resolveImage). */
  template: string;
  /** Shell command that reads the prompt from stdin and prints events on stdout. No secrets. */
  command(options: CommandOptions): string;
  /** Events for one stdout line. Throws when the line reports a failed run. */
  parseLine(line: string): HarnessEvent[];
}

/** Quotes a value for a POSIX shell. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
