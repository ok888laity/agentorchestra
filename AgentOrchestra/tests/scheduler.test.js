import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadPlanFile } from "../src/config.js";
import { planFromObject } from "../src/domain.js";
import { cleanup, makeRuntime, makeTempProject } from "./helpers.js";

function install(runtime, planName) {
  const plan = planFromObject(loadPlanFile(runtime.dir, `examples/${planName}`), runtime.config.policyDefaults);
  runtime.store.installPlan(plan, { replace: true });
  return plan;
}

test("starter DAG executes, gates pass, and the human gate stays closed", async (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const runtime = makeRuntime(dir);
  install(runtime, "starter.json");
  const summary = await runtime.scheduler.run({ maxSteps: 80 });
  assert.equal(summary.stopReason, "needs_approval");
  assert.equal(summary.accepted, 7);
  assert.equal(summary.total, 8);
  assert.ok(summary.simulatedResults >= 1);
  assert.equal(summary.simulatedOnly, false, "the deterministic script node is real evidence");
  assert.equal(runtime.store.getState().tasks.approval.status, "waiting_approval");
  assert.equal(runtime.store.getState().tasks.integrate.status, "done");
  assert.ok(runtime.store.getState().tasks.integrate.score >= 70);

  const snapshot = runtime.scheduler.statusSnapshot();
  const poolIds = new Set(snapshot.pool.slots.map((slot) => slot.modelId));
  for (const task of snapshot.tasks) {
    if (task.status !== "done" || task.assignedModel === "script/local") continue;
    assert.ok(poolIds.has(task.assignedModel), `${task.id} used ${task.assignedModel} outside the enforced pool`);
  }

  const checkPath = path.join(dir, "artifacts", "script-check", "latest", "check.json");
  assert.ok(fs.existsSync(checkPath));
  const check = JSON.parse(fs.readFileSync(checkPath, "utf8"));
  assert.equal(check.status, "ok");
  assert.ok(check.checkedAt);
  assert.equal(runtime.store.getState().tasks["script-check"].result.meta.simulated, false);
});

test("state can be resumed and a human can close the final gate", async (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const first = makeRuntime(dir);
  install(first, "starter.json");
  await first.scheduler.run({ maxSteps: 80 });
  assert.equal(first.store.getState().tasks.approval.status, "waiting_approval");

  const second = makeRuntime(dir);
  assert.equal(second.store.getState().tasks.integrate.status, "done");
  const approved = second.scheduler.approveTask("approval", "approve", "reviewed by test", "test-human");
  assert.equal(approved.ok, true);
  assert.equal(second.store.getState().tasks.approval.status, "done");
  const summary = await second.scheduler.run({ maxSteps: 10 });
  assert.equal(summary.stopReason, "complete");
});

test("a hard task with no API budget waits instead of downgrading", async (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const runtime = makeRuntime(dir);
  const plan = planFromObject({
    project: "budget",
    policy: {
      qualityPreference: 100,
      zeroExtraPaid: false,
      apiBudgetCny: 0,
      reviewMode: "off",
      maxAttempts: 1
    },
    tasks: [{
      id: "hard-design",
      title: "Hard design",
      brief: "A task only the frontier API model can meet.",
      group: "design",
      kind: "design",
      tier: "L1",
      role: "designer",
      difficulty: 5,
      confidentiality: 0,
      acceptance: { minChars: 200, mustContain: ["design"], artifacts: ["design.md"], critical: true }
    }]
  }, runtime.config.policyDefaults);
  runtime.store.installPlan(plan, { replace: true });
  const summary = await runtime.scheduler.run({ maxSteps: 10 });
  assert.equal(summary.stopReason, "waiting_budget");
  assert.equal(runtime.store.getState().tasks["hard-design"].status, "waiting_budget");
  assert.equal(runtime.store.getState().budget.apiSpentCny, 0);

  runtime.store.setPolicy({ apiBudgetCny: 20 });
  runtime.scheduler.wakeWaitingBudget();
  const second = await runtime.scheduler.run({ maxSteps: 10 });
  assert.equal(second.stopReason, "complete");
  assert.equal(runtime.store.getState().tasks["hard-design"].status, "done");
  assert.equal(runtime.store.getState().tasks["hard-design"].assignedModel, "mock/api-frontier");
});

test("tasks sharing a single-writer resource never overlap", async (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const runtime = makeRuntime(dir);
  const plan = planFromObject({
    project: "locks",
    policy: { reviewMode: "off", maxConcurrency: 2, qualityPreference: 40 },
    tasks: [
      {
        id: "write-a",
        title: "Write A",
        brief: "A",
        group: "cad",
        kind: "doc",
        tier: "L2",
        role: "documenter",
        difficulty: 1,
        resources: ["solidworks:assembly"],
        acceptance: { minChars: 20, mustContain: ["ok"] }
      },
      {
        id: "write-b",
        title: "Write B",
        brief: "B",
        group: "cad",
        kind: "doc",
        tier: "L2",
        role: "documenter",
        difficulty: 1,
        resources: ["solidworks:assembly"],
        acceptance: { minChars: 20, mustContain: ["ok"] }
      }
    ]
  }, runtime.config.policyDefaults);
  runtime.store.installPlan(plan, { replace: true });
  const summary = await runtime.scheduler.run({ maxSteps: 10 });
  assert.equal(summary.stopReason, "complete");
  const events = runtime.store.getState().events;
  const acquireA = events.findIndex((event) => event.kind === "locks.acquired" && event.data.taskId === "write-a");
  const releaseA = events.findIndex((event) => event.kind === "locks.released" && event.data.taskId === "write-a");
  const acquireB = events.findIndex((event) => event.kind === "locks.acquired" && event.data.taskId === "write-b");
  const releaseB = events.findIndex((event) => event.kind === "locks.released" && event.data.taskId === "write-b");
  assert.ok(acquireA >= 0 && releaseA > acquireA);
  assert.ok(acquireB >= 0 && releaseB > acquireB);
  const nonOverlapping = releaseA < acquireB || releaseB < acquireA;
  assert.equal(nonOverlapping, true);
  assert.deepEqual(runtime.store.getState().locks, {});
});

test("auto-decomposition creates children plus an integration node and rewires dependents", async (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const runtime = makeRuntime(dir);
  install(runtime, "recursive.json");
  const summary = await runtime.scheduler.run({ maxSteps: 80 });
  assert.equal(summary.stopReason, "complete");
  assert.equal(summary.accepted, 5);
  const state = runtime.store.getState();
  assert.equal(state.tasks.mechanism.status, "decomposed");
  assert.equal(state.tasks["mechanism-latch"].status, "done");
  assert.equal(state.tasks["mechanism-interlock"].status, "done");
  assert.equal(state.tasks["mechanism.integrate"].status, "done");
  assert.equal(state.tasks["final-note"].status, "done");
  assert.ok(state.tasks["final-note"].deps.includes("mechanism.integrate"));
  assert.equal(state.tasks["final-note"].deps.includes("mechanism"), false);
});

test("two schedulers cannot run concurrently against one root", async (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const firstRuntime = makeRuntime(dir);
  const secondRuntime = makeRuntime(dir);
  const plan = planFromObject({
    project: "run-lock",
    policy: { reviewMode: "off" },
    tasks: [{
      id: "lock-task",
      title: "Lock task",
      brief: "A task used to hold the run lock.",
      group: "lock",
      kind: "doc",
      tier: "L2",
      role: "documenter",
      difficulty: 1,
      acceptance: { minChars: 20, mustContain: ["ok"] }
    }]
  }, firstRuntime.config.policyDefaults);
  firstRuntime.store.installPlan(plan, { replace: true });
  const first = firstRuntime.scheduler.run({ maxSteps: 5 });
  await assert.rejects(
    () => secondRuntime.scheduler.run({ maxSteps: 5 }),
    /Another scheduler run is active/
  );
  await first;
  assert.equal(fs.existsSync(path.join(dir, ".orchestra", "RUN.lock")), false);
});

test("main-model completion still has to pass the deterministic gate", async (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const runtime = makeRuntime(dir);
  const plan = planFromObject({
    project: "main",
    policy: { reviewMode: "off" },
    tasks: [{
      id: "l0",
      title: "L0 decision",
      brief: "Main model owns this.",
      tier: "L0",
      role: "integrator",
      owner: "main",
      difficulty: 2,
      acceptance: { minChars: 30, mustContain: ["decision"], artifacts: ["decision.md"] }
    }]
  }, runtime.config.policyDefaults);
  runtime.store.installPlan(plan, { replace: true });
  const summary = await runtime.scheduler.run({ maxSteps: 5 });
  assert.equal(summary.stopReason, "needs_main_model");
  const bad = runtime.scheduler.completeByMain("l0", { output: "too short", artifacts: [] });
  assert.equal(bad.ok, false);
  assert.equal(runtime.store.getState().tasks.l0.status, "needs_main_model");
  const good = runtime.scheduler.completeByMain("l0", {
    output: "decision: proceed with the fixture. This is a long enough main-model output for the acceptance gate.",
    artifacts: [{ path: "decision.md", content: "decision: proceed" }]
  });
  assert.equal(good.ok, true);
  assert.equal(runtime.store.getState().tasks.l0.status, "done");
});
