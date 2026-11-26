import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, TOOL_ROOT } from "../src/config.js";
import { normalizePolicy, normalizeTask } from "../src/domain.js";
import { evaluateDeterministic } from "../src/quality.js";
import { routeTask } from "../src/router.js";
import { createState } from "../src/store.js";

const config = loadConfig(TOOL_ROOT);

function task(overrides = {}) {
  return normalizeTask({
    id: "t",
    title: "Task",
    brief: "Do a representative task.",
    role: "designer",
    kind: "design",
    tier: "L2",
    difficulty: 3,
    confidentiality: 0,
    ...overrides
  }, { policy: normalizePolicy({}) });
}

function route(taskOverrides = {}, policyOverrides = {}, extra = {}) {
  const policy = normalizePolicy({ ...config.policyDefaults, ...policyOverrides });
  const state = createState("test", policy);
  const modelTask = task(taskOverrides);
  return {
    task: modelTask,
    policy,
    state,
    result: routeTask({
      task: modelTask,
      models: config.models,
      roles: config.roles,
      policy,
      state,
      promptChars: 3000,
      ...extra
    })
  };
}

test("cost-first chooses a free model when it clears the quality bar", () => {
  const { result } = route(
    { role: "coder", kind: "code", difficulty: 2 },
    { qualityPreference: 0, zeroExtraPaid: true, apiBudgetCny: 0 }
  );
  assert.ok(result.selected);
  assert.equal(result.selected.costClass, "free");
  assert.ok(result.selected.quality >= result.minQuality);
});

test("quality-first can select an API model when budget is available", () => {
  const { result } = route(
    { role: "designer", difficulty: 5, tier: "L1", acceptance: { critical: false } },
    { qualityPreference: 100, zeroExtraPaid: false, apiBudgetCny: 20 }
  );
  assert.ok(result.selected);
  assert.equal(result.selected.costClass, "api");
});

test("confidential tasks are restricted to local models", () => {
  const { result } = route(
    { confidentiality: 2, difficulty: 3 },
    { qualityPreference: 0 }
  );
  assert.ok(result.selected);
  assert.equal(result.selected.privacy, "local");
  assert.ok(result.rejected.some((item) => item.code === "privacy_blocked" || item.code === "privacy_unknown"));
});

test("public-only model pools cannot serve confidential tasks", () => {
  const publicModels = config.models.filter((model) => model.privacy === "public");
  const policy = normalizePolicy({ qualityPreference: 0 });
  const state = createState("test", policy);
  const result = routeTask({
    task: task({ confidentiality: 2 }),
    models: publicModels,
    roles: config.roles,
    policy,
    state
  });
  assert.equal(result.selected, null);
  assert.ok(["privacy_blocked", "privacy_unknown"].includes(result.reason));
});

test("zero-extra-paid never selects an API model", () => {
  const { result } = route(
    { role: "designer", difficulty: 5, tier: "L1", acceptance: { critical: true } },
    { qualityPreference: 100, zeroExtraPaid: true, apiBudgetCny: 50 }
  );
  assert.ok(!result.selected || result.selected.costClass !== "api");
});

test("budget exhaustion pauses rather than silently downgrading", () => {
  const { result } = route(
    { role: "designer", difficulty: 5, tier: "L1", acceptance: { critical: true } },
    { qualityPreference: 100, zeroExtraPaid: false, apiBudgetCny: 0 }
  );
  assert.equal(result.selected, null);
  assert.equal(result.reason, "budget_exhausted");
});

test("minimum acceptance is independent of the cost/quality slider", () => {
  const modelTask = task({
    role: "coder",
    kind: "code",
    difficulty: 2,
    acceptance: {
      minChars: 80,
      mustContain: ["evidence"],
      artifacts: ["out.js"],
      requireEvidence: true
    }
  });
  const policy = normalizePolicy({ qualityPreference: 0, minTaskScore: 60 });
  const low = evaluateDeterministic(modelTask, { output: "TODO", artifacts: [] }, policy);
  const high = evaluateDeterministic(modelTask, {
    output: [
      "This implementation fixture includes a function and a reproducible evidence record.",
      "It is intentionally long enough to satisfy the minimum character requirement.",
      "## Evidence",
      "- Evidence class: real",
      "- Command: node out.js",
      "- Output: ok",
      "```js",
      "console.log('ok')",
      "```"
    ].join("\n"),
    artifacts: [{ name: "out.js", path: "out.js", content: "console.log('ok')" }],
    meta: { simulated: false }
  }, policy);
  assert.equal(low.pass, false);
  assert.equal(high.pass, true);
  assert.ok(high.score >= policy.minTaskScore);
});
