#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  loadConfig,
  loadPlanFile,
  resolveRoot,
  saveDiscoveredModels
} from "./config.js";
import { classifyHostModels, classificationSummaryText, writeProviderPolicy } from "./classify.js";
import { planFromObject, statusLabel } from "./domain.js";
import { confirmHostModels, readHostModels, syncHostModels } from "./host-models.js";
import { planPool, poolSummaryText } from "./pool.js";
import { ProviderHub } from "./providers/index.js";
import { routeTask, routePreviewText } from "./router.js";
import { Scheduler } from "./scheduler.js";
import { Store } from "./store.js";
import { formatCny, readJson, truncate } from "./util.js";

const VERSION = "0.1.0";

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const equal = body.indexOf("=");
    if (equal >= 0) {
      const key = camel(body.slice(0, equal));
      const value = body.slice(equal + 1);
      flags[key] = flags[key] === undefined ? value : [].concat(flags[key], value);
      continue;
    }
    const key = camel(body);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = flags[key] === undefined ? next : [].concat(flags[key], next);
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positional };
}

function camel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function numberFlag(value, fallback = null) {
  if (value === undefined || value === null || value === true) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boolFlag(value) {
  if (value === undefined) return undefined;
  if (value === true) return true;
  if (value === false) return false;
  return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
}

function createRuntime(root, project = "cli") {
  const config = loadConfig(root);
  const store = new Store(root, { project, policy: config.policyDefaults });
  const providers = new ProviderHub({ config, models: config.models });
  const scheduler = new Scheduler({
    root,
    store,
    config,
    providers,
    log: (message) => {
      if (process.env.AGENTORCHESTRA_DEBUG) process.stderr.write(`[agentorchestra] ${message}\n`);
    }
  });
  return { root, config, store, providers, scheduler };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function statusIcon(status) {
  return {
    done: "[ok]",
    running: "[..]",
    ready: "[  ]",
    pending: "[--]",
    failed: "[!!]",
    blocked: "[xx]",
    waiting_approval: "[??]",
    waiting_budget: "[$ ]",
    needs_main_model: "[M ]",
    needs_review: "[??]",
    decomposed: "[><]",
    cancelled: "[--]"
  }[status] ?? "[  ]";
}

function printTaskRows(snapshot) {
  for (const task of snapshot.tasks) {
    if (task.status === "decomposed") continue;
    const model = task.assignedModel ?? "—";
    const score = task.score === null || task.score === undefined ? "" : ` score=${task.score}`;
    const attempts = task.attempts ? ` a=${task.attempts}/${task.maxAttempts}` : "";
    process.stdout.write(
      `${statusIcon(task.status)} ${task.id.padEnd(24)} ${statusLabel(task.status).padEnd(6)} ` +
      `${String(task.group).padEnd(10)} ${String(model).padEnd(24)}${score}${attempts}\n`
    );
  }
}

function printNextActions(progress) {
  if (!progress.nextActions.length) return;
  process.stdout.write("\nNext actions:\n");
  for (const action of progress.nextActions) {
    process.stdout.write(`  - ${action.type}: ${action.taskId} — ${action.title}${action.reason ? ` (${action.reason})` : ""}\n`);
  }
}

function printRunSummary(summary) {
  process.stdout.write(`\nProject: ${summary.project}\n`);
  process.stdout.write(`Run: ${summary.stopReason} in ${summary.durationText} (${summary.steps} steps)\n`);
  process.stdout.write(`Progress: ${summary.progress}% (${summary.accepted}/${summary.total} accepted)\n`);
  process.stdout.write(`Active: ${summary.active} · waiting approval: ${summary.waitingApproval} · waiting budget: ${summary.waitingBudget} · blocked: ${summary.blocked}\n`);
  process.stdout.write(`Free-model share: ${summary.freeShare}% · Extra API spend: ${formatCny(summary.apiSpentCny)}\n`);
  process.stdout.write(`Main-model quota: ${summary.mainModelQuota?.status ?? "unknown"} (${summary.mainModelQuota?.reason ?? "not exposed"})\n`);
  if (summary.simulatedOnly) {
    process.stdout.write("\nWARNING: every accepted result is simulated mock output. This proves orchestration only, not engineering correctness.\n");
  }
  printNextActions(summary);
}

function printStatus(snapshot) {
  const progress = snapshot.progress;
  process.stdout.write(`AgentOrchestra ${VERSION} · ${snapshot.project}\n`);
  process.stdout.write(`State: ${snapshot.run.status} · stop=${snapshot.run.stopReason ?? "—"} · paused=${snapshot.paused} · running=${snapshot.running}\n`);
  process.stdout.write(`Progress: ${progress.progress}% (${progress.accepted}/${progress.total}) · free share ${progress.freeShare}% · API ${formatCny(progress.apiSpentCny)} / ${formatCny(progress.apiBudgetCny)}\n`);
  if (snapshot.pool) {
    process.stdout.write(`Model pool: ${snapshot.pool.slots.length}/${snapshot.pool.target} slots · ${snapshot.pool.distinctModels} distinct · free ${snapshot.pool.freeShare}% · wave ${formatCny(snapshot.pool.estimatedWaveCostCny)} · ${snapshot.pool.billingMode}\n`);
    for (const slot of snapshot.pool.slots) {
      process.stdout.write(`  slot ${slot.slot}: ${slot.role.padEnd(12)} ${slot.modelId} (${slot.costClass}/${slot.privacy})${slot.pinned ? " PINNED" : ""}\n`);
    }
    for (const shortage of snapshot.pool.shortages) {
      process.stdout.write(`  ! ${shortage.role}: ${shortage.reason} — ${shortage.reasonText}\n`);
    }
    for (const warning of snapshot.pool.warnings ?? []) {
      process.stdout.write(`  Warning: ${warning}\n`);
    }
  }
  process.stdout.write(`Main-model quota: ${snapshot.mainModelQuota.status} (${snapshot.mainModelQuota.reason})\n`);
  if (snapshot.warnings.length) {
    for (const warning of snapshot.warnings) process.stdout.write(`Warning: ${warning}\n`);
  }
  process.stdout.write("\nGroups:\n");
  for (const [group, bucket] of Object.entries(progress.byGroup)) {
    process.stdout.write(`  ${group.padEnd(12)} ${String(bucket.progress).padStart(5)}%  ${bucket.done}/${bucket.total} accepted, ${bucket.waiting} waiting, ${bucket.blocked} blocked\n`);
  }
  process.stdout.write("\nTasks:\n");
  printTaskRows(snapshot);
  if (snapshot.locks && Object.keys(snapshot.locks).length) {
    process.stdout.write("\nResource locks:\n");
    for (const lock of Object.values(snapshot.locks)) {
      process.stdout.write(`  ${lock.resource} -> ${lock.taskId} until ${lock.expiresAt}\n`);
    }
  }
  if (progress.modelUsage.length) {
    process.stdout.write("\nModel usage:\n");
    for (const usage of progress.modelUsage) {
      process.stdout.write(`  ${usage.modelId.padEnd(28)} runs=${usage.runs} success=${Math.round(usage.successRate * 100)}% avg=${usage.avgScore} cost=${formatCny(usage.costCny)}\n`);
    }
  }
  printNextActions(progress);
}

async function cmdDoctor(runtime, flags) {
  const { config, providers } = runtime;
  const checks = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ ok: nodeMajor >= 20, name: "Node.js >= 20", detail: process.version });
  const stateDir = path.join(runtime.root, ".orchestra");
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, ".doctor"), "ok");
    fs.rmSync(path.join(stateDir, ".doctor"), { force: true });
    checks.push({ ok: true, name: "State directory writable", detail: stateDir });
  } catch (error) {
    checks.push({ ok: false, name: "State directory writable", detail: error.message });
  }
  checks.push({ ok: config.models.length > 0, name: "Model catalog", detail: `${config.models.length} models` });
  const classification = classifyHostModels(runtime.root);
  checks.push({
    ok: true,
    name: "Host classification",
    detail: `${classification.groups.length} provider group(s); ${classification.choicesRequired.length} need explicit confirmation`
  });
  const hostModels = config.hostModels ?? [];
  const unconfirmedHost = hostModels.filter((model) => model.available && (model.costClass === "unknown" || model.privacy === "unknown"));
  checks.push({
    ok: true,
    name: "Host catalogue",
    detail: hostModels.length
      ? `${hostModels.length} host models; ${unconfirmedHost.length} still unconfirmed (billing/privacy)`
      : "no host models synced"
  });
  const probes = await providers.probeAll();
  for (const [provider, result] of Object.entries(probes)) {
    checks.push({ ok: Boolean(result.available), name: `Provider ${provider}`, detail: result.detail });
  }
  const mockModels = config.models.filter((model) => model.provider.startsWith("mock"));
  const usableRealModels = config.models.filter((model) =>
    !model.provider.startsWith("mock") && model.available && model.costClass !== "unknown" && model.privacy !== "unknown"
  );
  checks.push({
    ok: true,
    name: "Evidence mode",
    detail: usableRealModels.length
      ? `${usableRealModels.length} usable non-mock models configured`
      : `mock only (${mockModels.length} models); ${unconfirmedHost.length} host models need confirmation; all output is simulated`
  });
  const openaiKey = process.env.AGENTORCHESTRA_OPENAI_API_KEY;
  const openaiBase = process.env.AGENTORCHESTRA_OPENAI_BASE_URL;
  checks.push({
    ok: true,
    name: "OpenAI-compatible env",
    detail: `baseURL ${openaiBase ? "set" : "missing"} · API key ${openaiKey ? "set" : "missing"}`
  });
  process.stdout.write("AgentOrchestra doctor\n");
  for (const check of checks) process.stdout.write(`${check.ok ? "[ok]" : "[!!]"} ${check.name}: ${check.detail}\n`);
  process.stdout.write("\nNotes:\n");
  process.stdout.write("- Missing CLI/model credentials are warnings, not silent failures. The mock provider is offline-only.\n");
  process.stdout.write("- OpenCode/Codex adapter flags are templates; verify them against your installed version before production use.\n");
  process.stdout.write("- Subscription quota is not readable through a stable public API. Status reports 'unknown', never a fabricated number.\n");
  const critical = checks.filter((check) => ["State directory writable", "Model catalog"].includes(check.name));
  if (critical.some((check) => !check.ok)) process.exitCode = 1;
}

async function cmdModels(runtime, flags, positional) {
  const { config, providers, root } = runtime;
  if (positional[0] === "classify") {
    const report = classifyHostModels(root);
    if (flags.json) printJson(report);
    else process.stdout.write(`${classificationSummaryText(report)}\n`);
    return;
  }
  if (positional[0] === "set-provider") {
    const provider = flags.provider ?? positional[1];
    if (!provider) throw new Error("Usage: models set-provider --provider <name> [--billing ...] [--privacy ...]");
    const patch = {};
    if (flags.billing) patch.billing = flags.billing;
    if (flags.privacy) patch.privacy = flags.privacy;
    if (flags.enabled !== undefined) patch.enabled = boolFlag(flags.enabled);
    if (flags.allowPatterns) patch.allowPatterns = String(flags.allowPatterns).split(",").map((item) => item.trim()).filter(Boolean);
    if (!Object.keys(patch).length) throw new Error("No provider fields supplied");
    const updated = writeProviderPolicy(root, provider, patch);
    process.stdout.write(`${JSON.stringify({ provider, policy: updated }, null, 2)}\n`);
    return;
  }
  if (positional[0] === "sync") {
    const file = flags.file ?? positional[1];
    if (!file) throw new Error("Usage: models sync --file <host-models.json> [--billing subscription] [--privacy trusted] [--executor opencode]");
    const raw = readJson(path.resolve(file));
    const models = Array.isArray(raw) ? raw : raw.models;
    if (!Array.isArray(models)) throw new Error("Host model file must be an array or { models: [] }");
    const result = syncHostModels(root, {
      models,
      source: flags.source ?? "host",
      billing: flags.billing ?? "unknown",
      privacy: flags.privacy ?? "unknown",
      executor: flags.executor ?? "opencode"
    });
    process.stdout.write(`Synced ${result.count} host models -> ${result.file}\n`);
    process.stdout.write("Billing/privacy are only as trustworthy as the values you supplied. Unknown entries stay excluded from cost-sensitive execution.\n");
    return;
  }
  if (positional[0] === "confirm") {
    const existing = readHostModels(root);
    if (!existing?.models?.length) throw new Error("No host models discovered yet; run 'models sync' or let the OpenCode plugin refresh.");
    const result = confirmHostModels(root, {
      billing: flags.billing ?? existing.billing,
      privacy: flags.privacy ?? existing.privacy,
      executor: flags.executor ?? existing.executor,
      source: existing.source
    });
    process.stdout.write(`Confirmed ${result.count} host models as billing=${result.billing}, privacy=${result.privacy}, executor=${result.executor}\n`);
    process.stdout.write("This confirmation is preserved when the host refreshes its catalogue with unknown options.\n");
    return;
  }
  if (positional[0] === "discover") {
    const provider = flags.provider ?? positional[1];
    if (!provider) throw new Error("Usage: models discover --provider opencode|codex|openai");
    const discovered = await providers.discover(provider);
    if (!discovered.length) {
      process.stdout.write(`No models discovered from ${provider}.\n`);
      return;
    }
    const file = saveDiscoveredModels(root, discovered, config.settings);
    process.stdout.write(`Discovered ${discovered.length} models from ${provider} -> ${file}\n`);
    process.stdout.write("Conservative defaults were used: cost/privacy unknown unless the endpoint returned pricing. Edit config/models.local.json before quality-sensitive use.\n");
    return;
  }
  const models = config.models;
  if (flags.json) {
    printJson(models);
    return;
  }
  process.stdout.write(`${models.length} models in catalog\n`);
  for (const model of models) {
    const stats = runtime.store.getState().modelStats[model.id];
    process.stdout.write(
      `${model.available ? "[ok]" : "[--]"} ${model.id.padEnd(36)} ${model.costClass.padEnd(12)} ${model.privacy.padEnd(8)} ` +
      `ctx=${String(model.contextTokens).padEnd(7)} ` +
      `R${model.capabilities.reasoning} C${model.capabilities.coding} D${model.capabilities.design} V${model.capabilities.review} ` +
      `${model.host ? `HOST:${model.executor ?? "?"}` : ""} ${stats ? `runs=${stats.runs}` : ""}\n`
    );
  }
  process.stdout.write("\nUse 'models discover --provider opencode' or 'models sync --file ...' to refresh catalogues. Unknown privacy/cost entries are excluded by default.\n");
}

function cmdPool(runtime, flags) {
  const state = runtime.store.getState();
  const pool = planPool({
    tasks: Object.values(state.tasks),
    models: runtime.config.models,
    roles: runtime.config.roles,
    policy: state.policy,
    state,
    target: numberFlag(flags.target, null)
  });
  if (flags.json) {
    printJson(pool);
    return;
  }
  process.stdout.write(`${poolSummaryText(pool)}\n`);
  if (pool.omittedRoles.length) {
    process.stdout.write("\nOmitted roles:\n");
    for (const omitted of pool.omittedRoles) process.stdout.write(`  ${omitted.role}: ${omitted.reason}\n`);
  }
}

function cmdRoute(runtime, flags, positional) {
  const taskId = flags.task ?? positional[0];
  let tasks;
  if (flags.file) {
    const plan = planFromObject(loadPlanFile(runtime.root, flags.file), runtime.config.policyDefaults);
    tasks = plan.tasks;
  } else {
    tasks = Object.values(runtime.store.getState().tasks);
  }
  if (!tasks.length) throw new Error("No tasks. Run 'demo', 'plan --file ...', or pass --file.");
  const task = taskId ? tasks.find((item) => item.id === taskId) : tasks.find((item) => item.status === "ready");
  if (!task) throw new Error(`Task not found: ${taskId ?? "(no ready task)"}`);
  if (task.humanGate) {
    process.stdout.write(`${task.id}: human gate. No model will be selected; a human must approve.\n`);
    return;
  }
  if (task.kind === "script") {
    process.stdout.write(`${task.id}: deterministic script node. Command: ${task.command.join(" ")}\n`);
    return;
  }
  const policy = flags.quality !== undefined
    ? { ...runtime.store.getState().policy, qualityPreference: numberFlag(flags.quality, 50) }
    : runtime.store.getState().policy;
  const state = runtime.store.getState();
  const route = routeTask({
    task,
    models: runtime.config.models,
    roles: runtime.config.roles,
    policy,
    state,
    promptChars: task.brief.length + 3000
  });
  process.stdout.write(`Route preview for ${task.id} (${task.title})\n`);
  process.stdout.write(`${routePreviewText(route)}\n`);
  if (route.candidates.length) {
    process.stdout.write("\nCandidates:\n");
    for (const candidate of route.candidates.slice(0, 8)) {
      process.stdout.write(`  ${candidate.modelId.padEnd(28)} score=${candidate.score} quality=${candidate.quality} cost=${formatCny(candidate.estimateCny)} ${candidate.costClass}\n`);
    }
  }
  if (route.rejected.length) {
    const grouped = {};
    for (const item of route.rejected) grouped[item.code] = (grouped[item.code] ?? 0) + 1;
    process.stdout.write(`\nRejected: ${Object.entries(grouped).map(([code, count]) => `${code}×${count}`).join(", ")}\n`);
  }
}

function cmdPolicy(runtime, flags) {
  const patch = {};
  if (flags.quality !== undefined) patch.qualityPreference = numberFlag(flags.quality);
  if (flags.billing !== undefined) patch.billingMode = flags.billing;
  if (flags.poolSize !== undefined) patch.poolSize = flags.poolSize === "auto" ? "auto" : numberFlag(flags.poolSize);
  if (flags.enforcePool !== undefined) patch.enforcePool = boolFlag(flags.enforcePool);
  if (flags.budget !== undefined) patch.apiBudgetCny = numberFlag(flags.budget);
  if (flags.concurrency !== undefined) patch.maxConcurrency = numberFlag(flags.concurrency);
  if (flags.depth !== undefined) patch.maxDepth = numberFlag(flags.depth);
  if (flags.children !== undefined) patch.maxChildren = numberFlag(flags.children);
  if (flags.review !== undefined) patch.reviewMode = flags.review;
  if (flags.minReview !== undefined) patch.minReviewScore = numberFlag(flags.minReview);
  if (flags.minTask !== undefined) patch.minTaskScore = numberFlag(flags.minTask);
  if (flags.allowPaid !== undefined) {
    patch.zeroExtraPaid = !boolFlag(flags.allowPaid);
    patch.billingMode = boolFlag(flags.allowPaid) ? "allow-api" : "subscription";
  }
  if (flags.allowUnknownPrivacy !== undefined) patch.allowUnknownPrivacy = boolFlag(flags.allowUnknownPrivacy);
  if (flags.maxAttempts !== undefined) patch.maxAttempts = numberFlag(flags.maxAttempts);
  if (flags.wallMinutes !== undefined) patch.maxWallMinutes = numberFlag(flags.wallMinutes);
  if (flags.provider !== undefined) patch.providerAllowlist = [].concat(flags.provider);

  const currentPins = runtime.store.getState().policy.pins ?? { all: null, roles: {}, tasks: {} };
  const pins = {
    all: currentPins.all ?? null,
    roles: { ...(currentPins.roles ?? {}) },
    tasks: { ...(currentPins.tasks ?? {}) }
  };
  let pinsChanged = false;
  for (const entry of [].concat(flags.pin === undefined ? [] : flags.pin)) {
    const split = String(entry).indexOf("=");
    if (split < 0) throw new Error(`Invalid --pin "${entry}"; use role=modelId`);
    const target = String(entry).slice(0, split);
    const model = String(entry).slice(split + 1);
    if (!target || !model) throw new Error(`Invalid --pin "${entry}"; use role=modelId`);
    if (target === "all" || target === "*") pins.all = model;
    else pins.roles[target] = model;
    pinsChanged = true;
  }
  for (const entry of [].concat(flags.pinTask === undefined ? [] : flags.pinTask)) {
    const split = String(entry).indexOf("=");
    if (split < 0) throw new Error(`Invalid --pin-task "${entry}"; use taskId=modelId`);
    const taskId = String(entry).slice(0, split);
    const model = String(entry).slice(split + 1);
    if (!taskId || !model) throw new Error(`Invalid --pin-task "${entry}"; use taskId=modelId`);
    pins.tasks[taskId] = model;
    pinsChanged = true;
  }
  for (const target of [].concat(flags.unpin === undefined ? [] : flags.unpin)) {
    if (target === "all" || target === "*") pins.all = null;
    else delete pins.roles[target];
    pinsChanged = true;
  }
  for (const taskId of [].concat(flags.unpinTask === undefined ? [] : flags.unpinTask)) {
    delete pins.tasks[taskId];
    pinsChanged = true;
  }
  if (pinsChanged) patch.pins = pins;

  if (Object.keys(patch).length) {
    runtime.store.setPolicy(patch);
    process.stdout.write("Policy updated.\n");
  }
  process.stdout.write(`${JSON.stringify(runtime.store.getState().policy, null, 2)}\n`);
}

async function cmdEval(runtime, flags) {
  const { runEval } = await import("./eval.js");
  const result = await runEval({ config: runtime.config, root: runtime.root });
  printJson(result);
  if (!result.pass) process.exitCode = 1;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional.shift() ?? "help";
  const root = resolveRoot(flags.root ?? null);
  if (flags.version || command === "version") {
    process.stdout.write(`AgentOrchestra ${VERSION}\n`);
    return;
  }
  if (command === "help" || flags.help) {
    process.stdout.write([
      "AgentOrchestra — cost-aware, verification-driven multi-model orchestration",
      "",
      "Commands:",
      "  demo [--reset]                 Install the starter DAG, run it, print status",
      "  plan --file <plan.json>        Validate and install a DAG",
      "  models classify [--json]       Classify providers with evidence and confidence",
      "  models set-provider --provider <name> --billing ... --privacy ...",
      "  models sync --file <json>      Import host harness models (billing/privacy explicit)",
      "  models confirm --billing ... --privacy ...  Confirm discovered host models once",
      "  run [--max-steps 200]          Execute ready tasks (resumable)",
      "  status [--json]                Show persisted task/progress/cost state",
      "  pool [--target N]              Plan the worker model pool / slots",
      "  models [discover --provider]   List, discover or sync host models",
      "  route --task <id> [--file]     Explain a routing decision",
      "  policy [--billing ...] [--pin role=model]  Get or update policy",
      "  approve <task> [--reject]      Human gate decision",
      "  complete <task> --file <path>  Main-model completion with artifact",
      "  retry <task>                   Reset a failed task",
      "  decompose <task> --file <json> Split a task into children + integration",
      "  note add|list                  Shared project memory",
      "  mcp                            MCP stdio server",
      "  doctor                         Environment and provider checks",
      "  eval                           Routing/quality regression checks",
      "  reset --yes                    Erase state (not notes/events backups)",
      "",
      "Global: --root <dir> --json",
      "Examples:",
      "  node src/cli.js demo",
      "  node src/cli.js run --max-steps 50"
    ].join("\n") + "\n");
    return;
  }

  const runtime = createRuntime(root, flags.project ?? "cli");

  if (command === "demo") {
    const existing = Object.keys(runtime.store.getState().tasks).length;
    if (!existing || flags.reset) {
      const plan = planFromObject(loadPlanFile(root, flags.plan ?? "examples/starter.json"), runtime.config.policyDefaults);
      runtime.store.installPlan(plan, { replace: true });
      process.stdout.write(`Installed ${plan.tasks.length} tasks from ${flags.plan ?? "examples/starter.json"}.\n`);
    }
    const summary = await runtime.scheduler.run({ maxSteps: numberFlag(flags.maxSteps, 80) });
    printRunSummary(summary);
    return;
  }

  if (command === "plan") {
    const file = flags.file ?? positional[0];
    if (!file) throw new Error("Usage: plan --file <plan.json>");
    const plan = planFromObject(loadPlanFile(root, file), runtime.config.policyDefaults);
    runtime.store.installPlan(plan, { replace: true });
    process.stdout.write(`Installed ${plan.tasks.length} tasks for ${plan.project} from ${file}.\n`);
    for (const task of plan.tasks) {
      process.stdout.write(`  ${task.id.padEnd(28)} ${task.tier} ${task.role.padEnd(12)} deps=${task.deps.join(",") || "-"}\n`);
    }
    return;
  }

  if (command === "run") {
    if (!Object.keys(runtime.store.getState().tasks).length) throw new Error("No plan installed. Run 'demo' or 'plan --file ...' first.");
    const summary = await runtime.scheduler.run({
      maxSteps: numberFlag(flags.maxSteps, 200),
      providerFilter: flags.provider ?? null,
      stopOnApproval: Boolean(flags.stopOnApproval)
    });
    if (flags.json) printJson(summary);
    else printRunSummary(summary);
    if (["blocked", "failed"].includes(summary.stopReason)) process.exitCode = 2;
    return;
  }

  if (command === "status") {
    const snapshot = runtime.scheduler.statusSnapshot();
    if (flags.json) printJson(snapshot);
    else printStatus(snapshot);
    return;
  }

  if (command === "models") {
    await cmdModels(runtime, flags, positional);
    return;
  }

  if (command === "pool") {
    cmdPool(runtime, flags);
    return;
  }

  if (command === "route") {
    cmdRoute(runtime, flags, positional);
    return;
  }

  if (command === "policy") {
    cmdPolicy(runtime, flags);
    return;
  }

  if (command === "approve") {
    const taskId = positional[0] ?? flags.task;
    if (!taskId) throw new Error("Usage: approve <task-id> [--reject] [--note text]");
    const result = runtime.scheduler.approveTask(taskId, flags.reject ? "reject" : "approve", flags.note ?? "", flags.actor ?? "human");
    process.stdout.write(`${taskId}: ${result.task.status}${result.task.approval ? ` (${result.task.approval.decision})` : ""}\n`);
    return;
  }

  if (command === "complete") {
    const taskId = positional[0] ?? flags.task;
    if (!taskId) throw new Error("Usage: complete <task-id> --file <output.md> [--artifacts artifacts.json]");
    const output = flags.file ? fs.readFileSync(path.resolve(flags.file), "utf8") : (flags.text ?? "");
    let artifacts = [];
    if (flags.artifacts) {
      const raw = readJson(path.resolve(flags.artifacts));
      artifacts = Array.isArray(raw) ? raw : Object.entries(raw).map(([artifactPath, content]) => ({ path: artifactPath, content }));
    }
    const result = runtime.scheduler.completeByMain(taskId, { output, artifacts, score: numberFlag(flags.score, null), actor: flags.actor ?? "main-model" });
    if (!result.ok) {
      process.stdout.write(`Rejected by gate: ${result.gate.reason}\n`);
      for (const check of result.gate.checks.filter((item) => !item.ok)) process.stdout.write(`  - ${check.id}: ${check.detail}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${taskId}: done (score ${result.gate.score})\n`);
    }
    return;
  }

  if (command === "retry") {
    const taskId = positional[0] ?? flags.task;
    if (!taskId) throw new Error("Usage: retry <task-id>");
    runtime.scheduler.retryTask(taskId);
    process.stdout.write(`${taskId}: reset to pending\n`);
    return;
  }

  if (command === "decompose") {
    const taskId = positional[0] ?? flags.task;
    const file = flags.file;
    if (!taskId || !file) throw new Error("Usage: decompose <task-id> --file <subtasks.json>");
    const subtasks = readJson(path.resolve(file));
    const task = runtime.store.getState().tasks[taskId];
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    task.decomposeInto = Array.isArray(subtasks) ? subtasks : subtasks.tasks;
    task.autoDecompose = true;
    const result = runtime.scheduler.decomposeTask(task);
    printJson(result);
    return;
  }

  if (command === "note") {
    const sub = positional[0] ?? "list";
    if (sub === "add") {
      const text = flags.text ?? positional.slice(1).join(" ") ?? "";
      if (!text) throw new Error("Usage: note add \"text\" [--tags a,b] [--clearance 1]");
      const note = runtime.store.addNote({
        text,
        tags: flags.tags ? String(flags.tags).split(",") : [],
        clearance: numberFlag(flags.clearance, 1),
        source: flags.source ?? "human"
      });
      process.stdout.write(`Added note ${note.id}\n`);
      return;
    }
    const notes = runtime.store.getState().notes;
    if (flags.json) printJson(notes);
    else for (const note of notes.slice(-20)) {
      process.stdout.write(`${note.id} [${note.tags.join(",") || "-"}] c=${note.clearance} ${truncate(note.text, 120)}\n`);
    }
    return;
  }

  if (command === "reset") {
    if (!flags.yes) throw new Error("Refusing to erase state without --yes");
    runtime.store.reset({ project: flags.project ?? "cli", policy: runtime.config.policyDefaults });
    process.stdout.write("State reset. Config, models and examples were not changed.\n");
    return;
  }

  if (command === "doctor") {
    await cmdDoctor(runtime, flags);
    return;
  }

  if (command === "mcp") {
    const { startMcpServer } = await import("./mcp.js");
    await startMcpServer({ root });
    return;
  }

  if (command === "eval") {
    await cmdEval(runtime, flags);
    return;
  }

  throw new Error(`Unknown command: ${command}. Run 'node src/cli.js help'.`);
}

main().catch((error) => {
  process.stderr.write(`AgentOrchestra error: ${error.message}\n`);
  if (process.env.AGENTORCHESTRA_DEBUG && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
