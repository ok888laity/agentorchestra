import {
  clamp,
  nowIso,
  percent,
  shortHash,
  slugify,
  toArray
} from "./util.js";

export const DEFAULT_POLICY = {
  qualityPreference: 45,
  billingMode: "subscription",
  poolSize: "auto",
  enforcePool: true,
  pins: { all: null, roles: {}, tasks: {} },
  apiBudgetCny: 0,
  maxConcurrency: 3,
  maxDepth: 2,
  maxChildren: 6,
  reviewMode: "critical",
  minReviewScore: 70,
  minTaskScore: 60,
  zeroExtraPaid: true,
  allowUnknownPrivacy: false,
  allowUnknownCost: false,
  maxAttempts: 3,
  maxTasks: 60,
  maxWallMinutes: 30,
  lockLeaseMinutes: 20,
  allowScripts: true,
  allowedExecutables: ["node", "npm", "npx", "python", "python3"],
  providerAllowlist: [],
  requireCrossProviderReview: true,
  allowDelegateL0: false,
  stagnationLimit: 12
};

export function normalizePins(input = {}) {
  const raw = input ?? {};
  const roles = {};
  const tasks = {};
  for (const [role, model] of Object.entries(raw.roles ?? {})) {
    if (model) roles[String(role)] = String(model);
  }
  for (const [task, model] of Object.entries(raw.tasks ?? {})) {
    if (model) tasks[String(task)] = String(model);
  }
  return {
    all: raw.all ? String(raw.all) : null,
    roles,
    tasks
  };
}

export const TIER_BONUS = { L0: 18, L1: 8, L2: 0 };
export const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled", "decomposed"]);

export function normalizePolicy(input = {}) {
  const rawInput = input ?? {};
  const merged = { ...DEFAULT_POLICY, ...rawInput };
  const billingMode = rawInput.billingMode === "allow-api" || rawInput.zeroExtraPaid === false
    ? "allow-api"
    : rawInput.billingMode === "free-first"
      ? "free-first"
      : "subscription";
  if (billingMode !== "allow-api") merged.zeroExtraPaid = true;
  else if (rawInput.zeroExtraPaid === undefined) merged.zeroExtraPaid = false;
  const poolSize = merged.poolSize === "auto" || merged.poolSize === undefined || merged.poolSize === null
    ? "auto"
    : Math.round(clamp(Number(merged.poolSize), 1, 16));
  const policy = {
    ...merged,
    qualityPreference: Math.round(clamp(Number(merged.qualityPreference ?? 45), 0, 100)),
    billingMode,
    poolSize,
    enforcePool: Boolean(merged.enforcePool),
    pins: normalizePins(merged.pins),
    apiBudgetCny: Math.max(0, Number(merged.apiBudgetCny ?? 0)),
    maxConcurrency: Math.round(clamp(Number(merged.maxConcurrency ?? 3), 1, 16)),
    maxDepth: Math.round(clamp(Number(merged.maxDepth ?? 2), 0, 5)),
    maxChildren: Math.round(clamp(Number(merged.maxChildren ?? 6), 1, 20)),
    minReviewScore: Math.round(clamp(Number(merged.minReviewScore ?? 70), 0, 100)),
    minTaskScore: Math.round(clamp(Number(merged.minTaskScore ?? 60), 0, 100)),
    maxAttempts: Math.round(clamp(Number(merged.maxAttempts ?? 3), 1, 8)),
    maxTasks: Math.round(clamp(Number(merged.maxTasks ?? 60), 1, 500)),
    maxWallMinutes: Math.round(clamp(Number(merged.maxWallMinutes ?? 30), 1, 24 * 60)),
    lockLeaseMinutes: Math.round(clamp(Number(merged.lockLeaseMinutes ?? 20), 1, 24 * 60)),
    stagnationLimit: Math.round(clamp(Number(merged.stagnationLimit ?? 12), 3, 100)),
    reviewMode: ["off", "critical", "all"].includes(merged.reviewMode) ? merged.reviewMode : "critical",
    zeroExtraPaid: Boolean(merged.zeroExtraPaid),
    allowUnknownPrivacy: Boolean(merged.allowUnknownPrivacy),
    allowUnknownCost: Boolean(merged.allowUnknownCost),
    allowScripts: Boolean(merged.allowScripts),
    requireCrossProviderReview: Boolean(merged.requireCrossProviderReview),
    allowDelegateL0: Boolean(merged.allowDelegateL0),
    providerAllowlist: toArray(merged.providerAllowlist).map(String),
    allowedExecutables: toArray(merged.allowedExecutables).map(String)
  };
  return policy;
}

export function normalizeAcceptance(input = {}, kind = "general") {
  const raw = input ?? {};
  return {
    minChars: Math.max(0, Number(raw.minChars ?? 120)),
    mustContain: toArray(raw.mustContain).map(String).filter(Boolean),
    mustNotContain: toArray(raw.mustNotContain).map(String).filter(Boolean),
    artifacts: toArray(raw.artifacts).map(String).filter(Boolean),
    jsonKeys: toArray(raw.jsonKeys).map(String).filter(Boolean),
    requireCodeBlock: Boolean(raw.requireCodeBlock),
    requireEvidence: Boolean(raw.requireEvidence),
    requireJsonVerdict: Boolean(raw.requireJsonVerdict) || kind === "review" || kind === "approval",
    critical: Boolean(raw.critical),
    skipModelReview: Boolean(raw.skipModelReview)
  };
}

export function makeTaskId(input, existingIds = new Set(), fallbackTitle = "task") {
  if (input) {
    const id = String(input).trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
      throw new Error(`Invalid task id "${id}". Use letters, digits, dot, underscore or hyphen.`);
    }
    return id;
  }
  const base = slugify(fallbackTitle ?? "task");
  let candidate = base;
  let suffix = 0;
  while (existingIds.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${shortHash(`${base}:${suffix}`, 4)}`;
  }
  return candidate;
}

export function normalizeTask(input, { policy = DEFAULT_POLICY, existingIds = new Set(), defaultGroup = "General" } = {}) {
  const raw = input ?? {};
  const title = String(raw.title ?? raw.id ?? "Task");
  const id = makeTaskId(raw.id, existingIds, title);
  const kind = String(raw.kind ?? "general");
  const humanGate = Boolean(raw.humanGate) || kind === "approval" || raw.owner === "human";
  const tier = ["L0", "L1", "L2"].includes(raw.tier) ? raw.tier : "L2";
  const owner = humanGate
    ? "human"
    : raw.owner === "main" || (tier === "L0" && raw.owner !== "orchestra")
      ? "main"
      : "orchestra";
  const acceptance = normalizeAcceptance(raw.acceptance, kind);
  const timestamp = nowIso();
  return {
    id,
    title,
    brief: String(raw.brief ?? ""),
    group: String(raw.group ?? defaultGroup),
    kind,
    tier,
    role: String(raw.role ?? "generalist"),
    difficulty: Math.round(clamp(Number(raw.difficulty ?? 2), 1, 5)),
    confidentiality: Math.round(clamp(Number(raw.confidentiality ?? 0), 0, 2)),
    deps: [...new Set(toArray(raw.deps).map(String))],
    resources: [...new Set(toArray(raw.resources).map(String))],
    requiredCapabilities: toArray(raw.requiredCapabilities),
    acceptance,
    priority: Number(raw.priority ?? 0),
    maxAttempts: Math.round(clamp(Number(raw.maxAttempts ?? policy.maxAttempts), 1, 8)),
    humanGate,
    owner,
    autoDecompose: Boolean(raw.autoDecompose),
    decomposeInto: Array.isArray(raw.decomposeInto) ? raw.decomposeInto : [],
    command: toArray(raw.command).map(String),
    contextTags: toArray(raw.contextTags).map(String),
    estimateTokens: raw.estimateTokens ? Number(raw.estimateTokens) : null,
    status: raw.status ?? "pending",
    attempts: Number(raw.attempts ?? 0),
    triedModels: toArray(raw.triedModels).map(String),
    assignedModel: raw.assignedModel ?? null,
    route: raw.route ?? null,
    result: raw.result ?? null,
    review: raw.review ?? null,
    score: raw.score ?? null,
    error: raw.error ?? null,
    blockedReason: raw.blockedReason ?? null,
    parentId: raw.parentId ?? null,
    depth: Number(raw.depth ?? 0),
    children: toArray(raw.children).map(String),
    integratedBy: raw.integratedBy ?? null,
    simulated: Boolean(raw.simulated ?? raw.result?.meta?.simulated ?? false),
    approval: raw.approval ?? null,
    createdAt: raw.createdAt ?? timestamp,
    updatedAt: timestamp,
    startedAt: raw.startedAt ?? null,
    finishedAt: raw.finishedAt ?? null
  };
}

export function validateAndOrderTasks(tasks, policy) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error("Plan must contain at least one task");
  if (tasks.length > policy.maxTasks) throw new Error(`Plan has ${tasks.length} tasks; maxTasks is ${policy.maxTasks}`);
  const byId = new Map();
  for (const task of tasks) {
    if (byId.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    for (const dep of task.deps) {
      if (dep === task.id) throw new Error(`Task ${task.id} depends on itself`);
      if (!byId.has(dep)) throw new Error(`Task ${task.id} depends on missing task ${dep}`);
    }
  }

  const indegree = new Map(tasks.map((task) => [task.id, task.deps.length]));
  const dependents = new Map(tasks.map((task) => [task.id, []]));
  for (const task of tasks) {
    for (const dep of task.deps) dependents.get(dep).push(task.id);
  }
  const queue = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const dependent of dependents.get(id)) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) queue.push(dependent);
    }
  }
  if (order.length !== tasks.length) {
    const cyclic = tasks.filter((task) => indegree.get(task.id) > 0).map((task) => task.id);
    throw new Error(`Dependency cycle detected: ${cyclic.join(", ")}`);
  }

  const depth = new Map();
  for (const id of order) {
    const task = byId.get(id);
    const parentDepths = task.deps.map((dep) => depth.get(dep) ?? 0);
    depth.set(id, parentDepths.length ? Math.max(...parentDepths) + 1 : 0);
  }
  for (const task of tasks) task.depth = depth.get(task.id);
  const ordered = order.map((id) => byId.get(id));
  return { tasks: ordered, order, depth };
}

export function planFromObject(plan, policyDefaults = DEFAULT_POLICY) {
  if (!plan || !Array.isArray(plan.tasks)) throw new Error("Plan must be an object with a tasks array");
  const policy = normalizePolicy({ ...policyDefaults, ...(plan.policy ?? {}) });
  const ids = new Set();
  const tasks = [];
  for (const raw of plan.tasks) {
    const task = normalizeTask(raw, { policy, existingIds: ids });
    ids.add(task.id);
    tasks.push(task);
  }
  const ordered = validateAndOrderTasks(tasks, policy);
  return {
    project: String(plan.project ?? "orchestra-project"),
    description: String(plan.description ?? ""),
    policy,
    tasks: ordered.tasks,
    order: ordered.order
  };
}

export function taskDependencyState(tasksById, task) {
  const missing = [];
  const done = [];
  const failed = [];
  const blocked = [];
  const waiting = [];
  for (const depId of task.deps) {
    const dep = tasksById[depId];
    if (!dep) {
      missing.push(depId);
      continue;
    }
    if (dep.status === "done") done.push(depId);
    else if (["failed", "cancelled"].includes(dep.status)) failed.push(depId);
    else if (dep.status === "blocked") blocked.push(depId);
    else waiting.push(depId);
  }
  return { missing, done, failed, blocked, waiting, allDone: task.deps.length === done.length };
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function statusLabel(status) {
  const labels = {
    pending: "等待前置",
    ready: "可执行",
    running: "执行中",
    done: "已验收",
    failed: "失败",
    blocked: "阻塞",
    cancelled: "取消",
    waiting_approval: "待人工验收",
    waiting_budget: "等待预算",
    needs_main_model: "主模型负责",
    needs_review: "待人工复核",
    decomposed: "已分解"
  };
  return labels[status] ?? status;
}

export function progressOf(state) {
  const tasks = Object.values(state.tasks ?? {});
  const leaves = tasks.filter((task) => task.status !== "decomposed" && task.status !== "cancelled");
  let totalWeight = 0;
  let doneWeight = 0;
  for (const task of leaves) {
    const weight = 1 + (Math.max(1, task.difficulty) - 1) * 0.5;
    totalWeight += weight;
    if (task.status === "done") doneWeight += weight;
  }
  const byStatus = {};
  for (const task of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;

  const byGroup = {};
  for (const task of leaves) {
    const group = task.group || "General";
    if (!byGroup[group]) byGroup[group] = { total: 0, done: 0, active: 0, waiting: 0, blocked: 0, weight: 0, doneWeight: 0 };
    const bucket = byGroup[group];
    const weight = 1 + (Math.max(1, task.difficulty) - 1) * 0.5;
    bucket.total += 1;
    bucket.weight += weight;
    if (task.status === "done") {
      bucket.done += 1;
      bucket.doneWeight += weight;
    } else if (["running", "ready"].includes(task.status)) {
      bucket.active += 1;
    } else if (["waiting_approval", "waiting_budget", "needs_main_model", "needs_review"].includes(task.status)) {
      bucket.waiting += 1;
    } else if (["failed", "blocked", "cancelled"].includes(task.status)) {
      bucket.blocked += 1;
    }
  }
  for (const bucket of Object.values(byGroup)) {
    bucket.progress = percent(bucket.doneWeight, bucket.weight);
  }

  const attempts = state.attempts ?? [];
  const modelUsage = {};
  for (const attempt of attempts) {
    if (!attempt.modelId) continue;
    if (!modelUsage[attempt.modelId]) {
      modelUsage[attempt.modelId] = {
        modelId: attempt.modelId,
        provider: attempt.provider,
        costClass: attempt.costClass,
        runs: 0,
        successes: 0,
        qualitySum: 0,
        costCny: 0,
        tokensIn: 0,
        tokensOut: 0
      };
    }
    const usage = modelUsage[attempt.modelId];
    usage.runs += 1;
    usage.successes += attempt.success ? 1 : 0;
    usage.qualitySum += Number(attempt.score ?? 0);
    usage.costCny += Number(attempt.costCny ?? 0);
    usage.tokensIn += Number(attempt.tokensIn ?? 0);
    usage.tokensOut += Number(attempt.tokensOut ?? 0);
  }
  for (const usage of Object.values(modelUsage)) {
    usage.avgScore = usage.runs ? Math.round(usage.qualitySum / usage.runs) : 0;
    usage.successRate = usage.runs ? usage.successes / usage.runs : 0;
  }
  const agentAttempts = attempts.filter((attempt) => attempt.kind !== "review");
  const freeRuns = agentAttempts.filter((attempt) => attempt.costClass === "free").length;
  const simulatedResults = leaves.filter((task) => task.result?.meta?.simulated).length;

  const total = leaves.length;
  const accepted = leaves.filter((task) => task.status === "done").length;
  const active = leaves.filter((task) => ["running", "ready"].includes(task.status)).length;
  const waitingApproval = tasks.filter((task) => ["waiting_approval", "needs_review"].includes(task.status));
  const waitingBudget = tasks.filter((task) => task.status === "waiting_budget");
  const needsMain = tasks.filter((task) => task.status === "needs_main_model");
  const blocked = tasks.filter((task) => ["blocked", "failed"].includes(task.status));

  return {
    project: state.project,
    progress: percent(doneWeight, totalWeight),
    total,
    accepted,
    active,
    waitingApproval: waitingApproval.length,
    waitingBudget: waitingBudget.length,
    needsMainModel: needsMain.length,
    blocked: blocked.length,
    byStatus,
    byGroup,
    modelUsage: Object.values(modelUsage).sort((a, b) => b.runs - a.runs),
    freeShare: agentAttempts.length ? percent(freeRuns, agentAttempts.length) : 0,
    simulatedResults,
    simulatedOnly: simulatedResults > 0 && leaves.every((task) => task.status !== "done" || task.result?.meta?.simulated),
    apiSpentCny: Number(state.budget?.apiSpentCny ?? 0),
    apiBudgetCny: Number(state.policy?.apiBudgetCny ?? 0),
    subscriptionTokens: Number(state.budget?.subscriptionTokens ?? 0),
    mainModelQuota: state.mainModelQuota ?? { status: "unknown", reason: "The provider does not expose remaining quota to this tool." },
    nextActions: [
      ...waitingApproval.map((task) => ({ type: "approval", taskId: task.id, title: task.title })),
      ...waitingBudget.map((task) => ({ type: "budget", taskId: task.id, title: task.title })),
      ...needsMain.map((task) => ({ type: "main_model", taskId: task.id, title: task.title })),
      ...blocked.map((task) => ({ type: "blocked", taskId: task.id, title: task.title, reason: task.error ?? task.blockedReason }))
    ],
    run: state.run ?? { status: "idle", stopReason: null }
  };
}

export function normalizePlanPolicy(planPolicy, defaults) {
  return normalizePolicy({ ...defaults, ...(planPolicy ?? {}) });
}
