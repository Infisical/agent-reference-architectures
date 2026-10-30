import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJournal, loadInstanceId } from "./journal.js";
import { tempDir as makeTempDir } from "./test-helpers/fakes.js";

const tempDir = () => makeTempDir("journal-");

test("write, update, list and remove a record", () => {
  const dir = tempDir();
  const journal = createJournal(dir, () => {});
  journal.write({ runId: "r1", startedAt: "t", sessionId: "s1" });
  journal.write({ runId: "r1", startedAt: "t", sessionId: "s1", sandboxId: "b1" });
  assert.deepEqual(journal.list(), [{ runId: "r1", startedAt: "t", sessionId: "s1", sandboxId: "b1" }]);
  // The temp file is renamed away, never left beside the record.
  assert.deepEqual(readdirSync(dir), ["r1.json"]);
  journal.remove("r1");
  assert.deepEqual(journal.list(), []);
});

test("list survives a new journal on the same directory, as after a restart", () => {
  const dir = tempDir();
  createJournal(dir).write({ runId: "r1", startedAt: "t", sandboxId: "b1" });
  assert.deepEqual(createJournal(dir).list(), [{ runId: "r1", startedAt: "t", sandboxId: "b1" }]);
});

test("list skips unreadable files and leftover temp files", () => {
  const dir = tempDir();
  const logs: string[] = [];
  writeFileSync(join(dir, "bad.json"), "{");
  writeFileSync(join(dir, "r2.json.tmp"), "{}");
  assert.deepEqual(createJournal(dir, (m) => logs.push(m)).list(), []);
  assert.match(logs[0], /bad\.json/);
});

test("remove of a missing record is a no-op", () => {
  assert.doesNotThrow(() => createJournal(tempDir()).remove("nope"));
});

test("loadInstanceId: made once, then the same after a restart; another directory gets its own", () => {
  const dir = tempDir();
  const id = loadInstanceId(dir);
  assert.equal(loadInstanceId(dir), id);
  assert.notEqual(loadInstanceId(join(dir, "smoke")), id);
  assert.ok(createJournal(dir).list().length === 0, "the ID file isn't read as a run record");
});
