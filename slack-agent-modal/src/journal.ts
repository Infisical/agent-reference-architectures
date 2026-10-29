import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The remote resources one run holds. IDs only: the session token is never written here.
 * Each ID is added as soon as its resource exists, so a crash leaves enough to clean up.
 */
export interface RunRecord {
  runId: string;
  startedAt: string;
  sessionId?: string;
  sandboxId?: string;
}

export interface Journal {
  write(record: RunRecord): void;
  remove(runId: string): void;
  /** Every record left on disk, e.g. by a crash; unreadable files are skipped. */
  list(): RunRecord[];
}

/**
 * One JSON file per run in `dir`. Written to a temp file and renamed over the real one, so a
 * crash never leaves a half-written record. Records are only fields this process wrote, so the
 * file names come from randomUUID and never from user input.
 */
export function createJournal(dir: string, log: (message: string) => void = console.log): Journal {
  mkdirSync(dir, { recursive: true });
  const fileOf = (runId: string) => join(dir, `${runId}.json`);

  return {
    write(record) {
      const temp = `${fileOf(record.runId)}.tmp`;
      writeFileSync(temp, JSON.stringify(record));
      renameSync(temp, fileOf(record.runId));
    },
    remove(runId) {
      rmSync(fileOf(runId), { force: true });
    },
    list() {
      const records: RunRecord[] = [];
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        try {
          const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as RunRecord;
          if (typeof record.runId === "string") records.push(record);
        } catch (err) {
          log(`Ignoring unreadable run record ${name}: ${err}`);
        }
      }
      return records;
    },
  };
}

/**
 * A random ID for whoever owns `dir`, made on first use and kept there, so it survives restarts.
 * Sandboxes are tagged with it, so a startup sweep terminates only its own and never those of
 * another bot or smoke run sharing the Modal App.
 */
export function loadInstanceId(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "instance-id");
  try {
    const id = readFileSync(file, "utf8").trim();
    if (id) return id;
  } catch {
    // Not made yet.
  }
  const id = randomUUID();
  writeFileSync(file, id);
  return id;
}
