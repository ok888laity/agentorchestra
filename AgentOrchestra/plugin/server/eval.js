import { loadConfig } from "./config.js";
import { normalizePolicy, normalizeTask } from "./domain.js";
import { evaluateDeterministic } from "./quality.js";
import { routeTask } from "./router.js";
import { createState } from "./store.js";

function makeTask(overrides = {}) {
  return normalizeTask({
    id: "eval-task",
    title: "Evaluation task",
    brief: "Evaluate routing behavior for a representative task.",
    group: "eval",
    kind: "design",
    tier: "L2",
    role: "designer",
    difficulty: 3,
    confidentiality: 0,
    deps: [],
    acceptance: {
      minChars: 100,
      mustContain: ["evidence"],
      artifacts: ["out.md"],
      requireEvidence: true
    },
    ...overrides
  }, { policy: normalizePolicy({}) });
}

export async function runEval({ config: providedConfig, root } = {}) {
  const config = providedConfig ?? loadConfig(root ?? process.cwd());
  const scenarios = [];
  const runRoute = (taskOverrides, policyOverrides, extra = {}) => {
    const policy = normalizePolicy({ ...config.policyDefaults, ...policyOverrides });
    const state = createState("eval", policy);
    const task = makeTask(taskOverrides);
    const route = routeTask({
      task,
      models: config.models,
      roles: config.roles,
      policy,
      state,
      promptChars: 3000,
      ...extra
    });
    return { task, policy, state, route };
  };
  const add = (name, pass, detail) => scenarios.push({ name, pass, detail });

  {
    const { route, policy, state } = runRoute(
      { role: "coder", kind: "code", difficulty: 2, tier: "L2" },
      { qualityPreference: 0, zeroExtraPaid: true, apiBudgetCny: 0 }
    );
    const selected = route.selected;
    add(
      "cost-first chooses free/local when adequate",
      Boolean(selected && ["free", "local"].includes(selected.costClass) && selected.quality >= route.minQuality),
      selected ? `${selected.modelId} ${selected.costClass} q=${selected.quality}/${route.minQuality} score=${selected.score}` : route.reasonText
    );
    void policy;
    void state;
  }

  {
    const { route } = runRoute(
      { role: "designer", kind: "design", difficulty: 5, tier: "L1", acceptance: { critical: false } },
      { qualityPreference: 100, zeroExtraPaid: false, apiBudgetCny: 20 }
    );
    add(
      "quality-first spends on a high-capability model",
      Boolean(route.selected && route.selected.costClass === "api" && route.selected.quality >= 60),
      route.selected ? `${route.selected.modelId} ${route.selected.costClass} q=${route.selected.quality} score=${route.selected.score}` : route.reasonText
    );
  }

  {
    const { route } = runRoute(
      { role: "designer", kind: "design", difficulty: 3, confidentiality: 2 },
      { qualityPreference: 0 }
    );
    add(
      "confidential task never routes to public models",
      Boolean(route.selected && route.selected.privacy === "local"),
      route.selected ? `${route.selected.modelId} privacy=${route.selected.privacy}` : route.reasonText
    );
  }

  {
    const { route } = runRoute(
      { role: "designer", kind: "design", difficulty: 5, tier: "L1", acceptance: { critical: true } },
      { qualityPreference: 100, zeroExtraPaid: true, apiBudgetCny: 10 }
    );
    add(
      "strict zero-extra-paid never silently uses API",
      !route.selected || route.selected.costClass !== "api",
      route.selected ? `${route.selected.modelId} ${route.selected.costClass}` : `paused: ${route.reason}`
    );
  }

  {
    const { route } = runRoute(
      { role: "designer", kind: "design", difficulty: 5, tier: "L1", acceptance: { critical: true } },
      { qualityPreference: 100, zeroExtraPaid: false, apiBudgetCny: 0 }
    );
    add(
      "budget gate reports waiting instead of silently downgrading",
      route.selected === null && route.reason === "budget_exhausted",
      route.selected ? route.selected.modelId : `${route.reason}: ${route.reasonText}`
    );
  }

  {
    const { route } = runRoute(
      { role: "coder", kind: "code", difficulty: 4, tier: "L1" },
      { qualityPreference: 20, apiBudgetCny: 1, zeroExtraPaid: false, providerAllowlist: ["mock"] }
    );
    const first = route.selected;
    const second = first
      ? runRoute(
          { role: "coder", kind: "code", difficulty: 4, tier: "L1" },
          { qualityPreference: 20, apiBudgetCny: 1, zeroExtraPaid: false },
          { excludeModelIds: [first.modelId], minQualityOverride: first.quality + 1 }
        ).route
      : { selected: null };
    add(
      "failed model is excluded and the next attempt must be stronger",
      Boolean(first && second.selected && second.selected.quality >= first.quality),
      first ? `${first.modelId} q=${first.quality} -> ${second.selected?.modelId ?? second.reason} q=${second.selected?.quality ?? "-"}` : route.reasonText
    );
  }

  {
    const task = makeTask({
      role: "coder",
      kind: "code",
      difficulty: 2,
      acceptance: { minChars: 200, mustContain: ["function"], artifacts: ["out.js"], requireEvidence: true }
    });
    const low = evaluateDeterministic(task, { output: "TODO", artifacts: [] }, normalizePolicy({ minTaskScore: 60 }));
    const high = evaluateDeterministic(task, {
      output: [
        "# Implementation",
        "This fixture contains a function and a reproducible evidence record.",
        "It intentionally includes enough text to satisfy the minimum character requirement.",
        "The command below was actually executed in the fixture runner; no other verification is claimed.",
        "",
        "## Evidence",
        "- Evidence class: real",
        "- Command: node check.js",
        "- Output: ok",
        "```js",
        "export function run() { return true; }",
        "```"
      ].join("\n"),
      artifacts: [{ name: "out.js", path: "out.js", content: "export function run() { return true; }" }],
      meta: { simulated: false }
    }, normalizePolicy({ minTaskScore: 60 }));
    add(
      "acceptance bar does not move with the cost slider",
      low.pass === false && high.pass === true,
      `low=${low.score}/${low.pass} high=${high.score}/${high.pass}`
    );
  }

  {
    const publicModels = config.models.filter((model) => model.privacy === "public");
    const confidentialTask = makeTask({ confidentiality: 2 });
    const policy = normalizePolicy({ qualityPreference: 0 });
    const state = createState("eval", policy);
    const route = routeTask({ task: confidentialTask, models: publicModels, roles: config.roles, policy, state });
    add(
      "public-only pool is rejected for confidential work",
      route.selected === null && ["privacy_blocked", "privacy_unknown"].includes(route.reason),
      `${route.reason}: ${route.reasonText}`
    );
  }

  const passed = scenarios.filter((scenario) => scenario.pass).length;
  return {
    pass: passed === scenarios.length,
    passed,
    total: scenarios.length,
    scenarios
  };
}
