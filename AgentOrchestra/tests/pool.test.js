import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { TOOL_ROOT, loadConfig, loadPlanFile } from "../src/config.js";
import { normalizePolicy, normalizeTask, planFromObject } from "../src/domain.js";
import { confirmHostModels, syncHostModels } from "../src/host-models.js";
import { planPool } from "../src/pool.js";
import { routeTask } from "../src/router.js";
import { createState } from "../src/store.js";
import { cleanup, makeTempProject } from "./helpers.js";

const config = loadConfig(TOOL_ROOT);

function task(overrides = {}) {
  return normalizeTask({
    id: "pool-task",
    title: "Pool task",
    brief: "Do the work.",
    group: "test",
    kind: "design",
    tier: "L2",
    role: "designer",
    difficulty: 3,
    confidentiality: 0,
    ...overrides
  }, { policy: normalizePolicy({}) });
}

function routeWith(taskOverrides, policyOverrides = {}) {
  const policy = normalizePolicy({ ...config.policyDefaults, ...policyOverrides });
  const state = createState("test", policy);
  const modelTask = task(taskOverrides);
  return {
    policy,
    state,
    task: modelTask,
    route: routeTask({
      task: modelTask,
      models: config.models,
      roles: config.roles,
      policy,
      state,
      promptChars: 2000
    })
  };
}

test("a pinned role model is selected when it is eligible", () => {
  const { route } = routeWith(
    { role: "coder", kind: "code", difficulty: 3 },
    { pins: { roles: { coder: "mock/sub-coder" } } }
  );
  assert.ok(route.selected);
  assert.equal(route.selected.modelId, "mock/sub-coder");
  assert.equal(route.selected.pinned, true);
});

test("an ineligible pin fails closed instead of silently falling back", () => {
  const { route } = routeWith(
    { role: "coder", kind: "code", difficulty: 3 },
    {
      billingMode: "subscription",
      zeroExtraPaid: true,
      pins: { roles: { coder: "mock/api-frontier" } }
    }
  );
  assert.equal(route.selected, null);
  assert.equal(route.reason, "pin_ineligible");
  assert.match(route.reasonText, /mock\/api-frontier/);
});

test("a missing pin is reported clearly", () => {
  const { route } = routeWith(
    { role: "coder", kind: "code", difficulty: 3 },
    { pins: { all: "missing/model" } }
  );
  assert.equal(route.selected, null);
  assert.equal(route.reason, "pin_missing");
});

test("billingMode=subscription excludes API-metered models", () => {
  const { route } = routeWith(
    { role: "designer", difficulty: 5, tier: "L1", acceptance: { critical: true } },
    { billingMode: "subscription", zeroExtraPaid: true, qualityPreference: 100 }
  );
  assert.equal(route.selected, null);
  assert.ok(["billing_mode_blocked", "quality_bar_not_met", "budget_exhausted"].includes(route.reason));
  assert.ok(route.rejected.every((item) => item.code !== "selected"));
});

test("billingMode=allow-api can select a frontier model within budget", () => {
  const { route } = routeWith(
    { role: "designer", difficulty: 5, tier: "L1", acceptance: { critical: false } },
    { billingMode: "allow-api", zeroExtraPaid: false, apiBudgetCny: 20, qualityPreference: 100 }
  );
  assert.ok(route.selected);
  assert.equal(route.selected.costClass, "api");
});

test("pool planner sizes slots from concurrency, reserves a reviewer, and honors pins", () => {
  const plan = planFromObject(loadPlanFile(TOOL_ROOT, "examples/starter.json"), config.policyDefaults);
  const policy = normalizePolicy({ ...plan.policy, maxConcurrency: 3, reviewMode: "critical", poolSize: "auto", pins: { roles: { reviewer: "mock/reviewer" } } });
  const state = createState("pool", policy);
  const pool = planPool({
    tasks: plan.tasks,
    models: config.models,
    roles: config.roles,
    policy,
    state
  });
  assert.equal(pool.target, 3);
  assert.ok(pool.slots.length <= 3);
  assert.ok(pool.slots.some((slot) => slot.role === "reviewer"));
  assert.ok(pool.slots.some((slot) => slot.role === "reviewer" && slot.modelId === "mock/reviewer" && slot.pinned));
  assert.equal(pool.billingMode, "subscription");
});

test("host provider policy disables opencode, enables only free opencode-go, and marks openai as API", (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.join(dir, ".orchestra"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".orchestra", "host-policy.json"), JSON.stringify({
    providers: {
      opencode: { enabled: false },
      "opencode-go": { enabled: true, allowPatterns: ["qwen", "hungerg"], billing: "auto", paidBilling: "subscription", privacy: "public", userChoice: true },
      openai: { enabled: true, billing: "api", privacy: "unknown", userChoice: true }
    }
  }, null, 2));
  syncHostModels(dir, {
    source: "opencode",
    billing: "unknown",
    privacy: "unknown",
    executor: "host-opencode",
    models: [
      { providerID: "opencode", id: "free-one", remoteModel: "opencode/free-one", label: "Free One" },
      { providerID: "opencode-go", id: "hungerg-free", remoteModel: "opencode-go/hungerg-free", label: "HungerG Free" },
      { providerID: "opencode-go", id: "qwen4-max", remoteModel: "opencode-go/qwen4-max", label: "Qwen4 Max" },
      { providerID: "opencode-go", id: "paid-one", remoteModel: "opencode-go/paid-one", label: "Paid One" },
      { providerID: "opencode-go", id: "gemini-4", remoteModel: "opencode-go/gemini-4", label: "Gemini 4" },
      { providerID: "openai", id: "gpt-paid", remoteModel: "openai/gpt-paid", label: "GPT Paid" }
    ]
  });
  const loaded = loadConfig(dir);
  const byRemote = Object.fromEntries(loaded.models.filter((model) => model.host).map((model) => [model.remoteModel, model]));
  assert.equal(byRemote["opencode/free-one"].available, false);
  assert.equal(byRemote["opencode-go/hungerg-free"].available, true);
  assert.equal(byRemote["opencode-go/hungerg-free"].costClass, "free");
  assert.equal(byRemote["opencode-go/hungerg-free"].privacy, "public");
  assert.equal(byRemote["opencode-go/qwen4-max"].available, true);
  assert.equal(byRemote["opencode-go/qwen4-max"].costClass, "subscription");
  assert.equal(byRemote["opencode-go/qwen4-max"].privacy, "public");
  assert.equal(byRemote["opencode-go/paid-one"].available, false);
  assert.equal(byRemote["opencode-go/gemini-4"].available, false);
  assert.equal(byRemote["openai/gpt-paid"].costClass, "api");
  assert.equal(byRemote["openai/gpt-paid"].privacy, "unknown");
});

test("host models sync into the catalogue but unknown billing/privacy stays excluded", (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const result = syncHostModels(dir, {
    source: "opencode",
    billing: "subscription",
    privacy: "local",
    executor: "mock",
    models: [{
      providerID: "mock",
      id: "host-worker",
      name: "Host worker",
      remoteModel: "mock/host-worker",
      contextTokens: 64000,
      capabilities: { reasoning: 80, coding: 80, tools: 80 }
    }]
  });
  assert.equal(result.count, 1);
  const loaded = loadConfig(dir);
  const host = loaded.models.find((model) => model.id.startsWith("host:"));
  assert.ok(host);
  assert.equal(host.costClass, "subscription");
  assert.equal(host.privacy, "local");
  assert.equal(host.host, true);

  const confirmed = confirmHostModels(dir, { billing: "subscription", privacy: "trusted", executor: "mock" });
  assert.equal(confirmed.privacy, "trusted");

  // A host refresh with unknown options must not erase the confirmed boundary.
  const refreshed = syncHostModels(dir, {
    source: "opencode",
    billing: "unknown",
    privacy: "unknown",
    executor: "mock",
    models: [{
      providerID: "mock",
      id: "host-worker",
      name: "Host worker",
      remoteModel: "mock/host-worker"
    }]
  });
  assert.equal(refreshed.billing, "subscription");
  assert.equal(refreshed.privacy, "trusted");

  const unknownDir = makeTempProject();
  t.after(() => cleanup(unknownDir));
  syncHostModels(unknownDir, {
    source: "opencode",
    billing: "unknown",
    privacy: "unknown",
    executor: "mock",
    models: [{ providerID: "mock", id: "unknown-worker", remoteModel: "mock/unknown-worker" }]
  });
  const loadedUnknown = loadConfig(unknownDir);
  const unknown = loadedUnknown.models.find((model) => model.id.includes("unknown-worker"));
  assert.ok(unknown);
  assert.equal(unknown.costClass, "unknown");
  const policy = normalizePolicy({ ...loadedUnknown.policyDefaults, billingMode: "subscription" });
  const state = createState("host", policy);
  const hostTask = task({ role: "coder", kind: "code", difficulty: 2 });
  const route = routeTask({
    task: { ...hostTask, pinnedModel: unknown.id },
    models: loadedUnknown.models,
    roles: loadedUnknown.roles ?? config.roles,
    policy,
    state
  });
  assert.equal(route.selected, null);
  assert.equal(route.reason, "pin_ineligible");
});
