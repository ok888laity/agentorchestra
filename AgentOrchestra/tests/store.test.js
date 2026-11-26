import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { normalizePolicy, normalizeTask } from "../src/domain.js";
import { Store } from "../src/store.js";
import { cleanup, makeTempProject } from "./helpers.js";

test("state persists across store instances", (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const store = new Store(dir, { project: "p", policy: normalizePolicy({ qualityPreference: 33 }) });
  store.recordEvent("info", "test", "hello");
  store.addNote({ text: "note text", tags: ["a"], clearance: 1 });
  const task = normalizeTask({ id: "a", title: "A" }, { policy: store.getState().policy });
  store.addTask(task);

  const reloaded = new Store(dir);
  assert.equal(reloaded.getState().project, "p");
  assert.equal(reloaded.getState().policy.qualityPreference, 33);
  assert.equal(reloaded.getState().tasks.a.title, "A");
  assert.equal(reloaded.getState().notes.length, 1);
  assert.ok(fs.existsSync(path.join(dir, ".orchestra", "journal.jsonl")));
});

test("resource locks are exclusive and released explicitly", (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const store = new Store(dir);
  const first = store.acquireLocks("task-a", ["solidworks:assembly"], 60_000);
  assert.equal(first.ok, true);
  const blocked = store.acquireLocks("task-b", ["solidworks:assembly"], 60_000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.held[0].taskId, "task-a");
  assert.deepEqual(store.releaseLocks("task-a"), ["solidworks:assembly"]);
  const second = store.acquireLocks("task-b", ["solidworks:assembly"], 60_000);
  assert.equal(second.ok, true);
});

test("expired locks are purged before acquisition", (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const store = new Store(dir);
  store.getState().locks["r"] = {
    resource: "r",
    taskId: "old",
    acquiredAt: new Date(Date.now() - 2000).toISOString(),
    expiresAt: new Date(Date.now() - 1000).toISOString()
  };
  store.save();
  const result = store.acquireLocks("new", ["r"], 60_000);
  assert.equal(result.ok, true);
  assert.equal(store.getState().locks.r.taskId, "new");
});

test("policy updates persist and are clamped", (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const store = new Store(dir);
  store.setPolicy({ qualityPreference: 140, maxConcurrency: 0 });
  assert.equal(store.getState().policy.qualityPreference, 100);
  assert.equal(store.getState().policy.maxConcurrency, 1);
  const reloaded = new Store(dir);
  assert.equal(reloaded.getState().policy.qualityPreference, 100);
});
