import assert from "node:assert/strict";
import test from "node:test";
import { normalizePolicy, normalizeTask, planFromObject, progressOf, validateAndOrderTasks } from "../src/domain.js";
import { createState } from "../src/store.js";

test("dependency cycles are rejected", () => {
  const policy = normalizePolicy({});
  const a = normalizeTask({ id: "a", title: "A", deps: ["b"] }, { policy });
  const b = normalizeTask({ id: "b", title: "B", deps: ["a"] }, { policy });
  assert.throws(() => validateAndOrderTasks([a, b], policy), /cycle/i);
});

test("depths are computed from dependencies", () => {
  const policy = normalizePolicy({});
  const tasks = [
    normalizeTask({ id: "a", title: "A" }, { policy }),
    normalizeTask({ id: "b", title: "B", deps: ["a"] }, { policy }),
    normalizeTask({ id: "c", title: "C", deps: ["b"] }, { policy })
  ];
  const ordered = validateAndOrderTasks(tasks, policy);
  assert.equal(ordered.tasks.find((task) => task.id === "a").depth, 0);
  assert.equal(ordered.tasks.find((task) => task.id === "b").depth, 1);
  assert.equal(ordered.tasks.find((task) => task.id === "c").depth, 2);
});

test("plan policy overrides defaults and task defaults are normalized", () => {
  const plan = planFromObject({
    project: "p",
    policy: { qualityPreference: 10, maxConcurrency: 99 },
    tasks: [{ id: "a", title: "A", brief: "b" }]
  }, normalizePolicy({}));
  assert.equal(plan.policy.qualityPreference, 10);
  assert.equal(plan.policy.maxConcurrency, 16);
  assert.equal(plan.tasks[0].acceptance.minChars, 120);
});

test("progress excludes decomposed container nodes and weights difficulty", () => {
  const state = createState("p", normalizePolicy({}));
  state.tasks = {
    parent: { id: "parent", status: "decomposed", difficulty: 5, group: "g", title: "P" },
    a: { id: "a", status: "done", difficulty: 1, group: "g", title: "A" },
    b: { id: "b", status: "pending", difficulty: 5, group: "g", title: "B" }
  };
  state.order = ["parent", "a", "b"];
  const progress = progressOf(state);
  assert.equal(progress.total, 2);
  assert.equal(progress.accepted, 1);
  assert.ok(progress.progress > 0 && progress.progress < 100);
});
