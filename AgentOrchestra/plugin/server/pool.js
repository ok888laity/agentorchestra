import { resolvePin, routeTask } from "./router.js";

function isPoolCandidate(task) {
  return task
    && !task.humanGate
    && task.owner !== "human"
    && task.kind !== "script"
    && !["decomposed", "cancelled"].includes(task.status);
}

function roleRepresentative(tasks, role) {
  const candidates = tasks.filter((task) => isPoolCandidate(task) && (task.role || "generalist") === role);
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => {
    const scoreA = Number(a.difficulty ?? 0) * 10 + Number(a.confidentiality ?? 0) * 8 + Number(a.priority ?? 0);
    const scoreB = Number(b.difficulty ?? 0) * 10 + Number(b.confidentiality ?? 0) * 8 + Number(b.priority ?? 0);
    return scoreB - scoreA;
  })[0];
}

function poolTask(task, role) {
  return {
    ...task,
    id: `__pool_${role}`,
    title: `Pool slot: ${role}`,
    role,
    humanGate: false,
    owner: "orchestra",
    deps: [],
    autoDecompose: false,
    decomposeInto: [],
    acceptance: {
      ...(task.acceptance ?? {}),
      critical: Boolean(task.acceptance?.critical),
      skipModelReview: true
    }
  };
}

function reviewerRepresentative(tasks) {
  const source = [...tasks].filter(isPoolCandidate).sort((a, b) => {
    const scoreA = Number(a.difficulty ?? 0) * 10 + Number(a.confidentiality ?? 0) * 8;
    const scoreB = Number(b.difficulty ?? 0) * 10 + Number(b.confidentiality ?? 0) * 8;
    return scoreB - scoreA;
  })[0] ?? {
    id: "review",
    title: "Independent review",
    brief: "Review accepted work against its acceptance criteria.",
    group: "review",
    kind: "review",
    tier: "L1",
    role: "reviewer",
    difficulty: 4,
    confidentiality: 0,
    acceptance: { minChars: 80, critical: false, skipModelReview: true }
  };
  return poolTask({
    ...source,
    kind: "review",
    tier: "L1",
    role: "reviewer",
    difficulty: Math.max(3, Number(source.difficulty ?? 4)),
    acceptance: { ...(source.acceptance ?? {}), critical: false, skipModelReview: true }
  }, "reviewer");
}

export function planPool({
  tasks,
  models,
  roles,
  policy,
  state,
  target: targetOverride = null
}) {
  const taskList = (Array.isArray(tasks) ? tasks : Object.values(tasks ?? {})).filter(isPoolCandidate);
  const target = Math.max(
    1,
    Math.round(targetOverride ?? (policy.poolSize === "auto" ? policy.maxConcurrency : Number(policy.poolSize ?? policy.maxConcurrency)))
  );
  const roleNames = [...new Set(taskList.map((task) => task.role || "generalist"))];
  const reviewNeeded = policy.reviewMode !== "off" && taskList.some((task) =>
    task.acceptance?.critical || Number(task.difficulty ?? 0) >= 4 || Number(task.confidentiality ?? 0) >= 2 || task.kind === "review"
  );
  const reviewerReserve = reviewNeeded && target > 1;

  const representatives = roleNames
    .map((role) => ({ role, task: roleRepresentative(taskList, role) }))
    .filter((entry) => entry.task)
    .sort((a, b) => {
      const scoreA = Number(a.task.difficulty ?? 0) * 10 + Number(a.task.confidentiality ?? 0) * 8;
      const scoreB = Number(b.task.difficulty ?? 0) * 10 + Number(b.task.confidentiality ?? 0) * 8;
      return scoreB - scoreA;
    });

  if (reviewerReserve && !representatives.some((entry) => entry.role === "reviewer")) {
    representatives.push({ role: "reviewer", task: reviewerRepresentative(taskList) });
  }

  let selected = representatives.slice(0, target);
  if (reviewerReserve && selected.length === target && !selected.some((entry) => entry.role === "reviewer")) {
    selected = [
      ...representatives.filter((entry) => entry.role !== "reviewer").slice(0, Math.max(0, target - 1)),
      representatives.find((entry) => entry.role === "reviewer")
    ].filter(Boolean);
  }

  const slots = [];
  const shortages = [];
  const warnings = [];
  for (const entry of selected) {
    const task = poolTask(entry.task, entry.role);
    const route = routeTask({
      task,
      models,
      roles,
      policy,
      state,
      promptChars: String(task.brief ?? "").length + 2000
    });
    if (!route.selected) {
      shortages.push({
        role: entry.role,
        taskId: entry.task.id,
        reason: route.reason,
        reasonText: route.reasonText,
        pinnedModel: resolvePin(task, policy)
      });
      continue;
    }
    const selectedModel = route.selected;
    slots.push({
      slot: slots.length + 1,
      role: entry.role,
      taskId: entry.task.id,
      modelId: selectedModel.modelId,
      label: selectedModel.label,
      provider: selectedModel.provider,
      costClass: selectedModel.costClass,
      privacy: selectedModel.privacy,
      quality: selectedModel.quality,
      minQuality: route.minQuality,
      score: selectedModel.score,
      estimateCny: selectedModel.estimateCny,
      pinned: Boolean(selectedModel.pinned),
      host: Boolean(selectedModel.model?.host),
      source: selectedModel.model?.source ?? "config"
    });
  }

  const addPinnedSlot = (pinId, sourceTask, roleLabel) => {
    if (!pinId || slots.some((slot) => slot.modelId === pinId)) return;
    const source = sourceTask ?? poolTask({
      id: "__pin__",
      title: "Pinned model",
      brief: "Eligibility check for a pinned model.",
      kind: "generalist",
      tier: "L2",
      role: roleLabel,
      difficulty: 2,
      confidentiality: 0,
      acceptance: { minChars: 0, critical: false, skipModelReview: true }
    }, roleLabel);
    const route = routeTask({
      task: { ...source, role: roleLabel, pinnedModel: pinId },
      models,
      roles,
      policy,
      state,
      promptChars: String(source.brief ?? "").length + 1000
    });
    if (!route.selected) {
      shortages.push({
        role: roleLabel,
        taskId: source.id,
        reason: route.reason,
        reasonText: route.reasonText,
        pinnedModel: pinId
      });
      return;
    }
    slots.push({
      slot: slots.length + 1,
      role: roleLabel,
      taskId: source.id,
      modelId: route.selected.modelId,
      label: route.selected.label,
      provider: route.selected.provider,
      costClass: route.selected.costClass,
      privacy: route.selected.privacy,
      quality: route.selected.quality,
      minQuality: route.minQuality,
      score: route.selected.score,
      estimateCny: route.selected.estimateCny,
      pinned: true,
      host: Boolean(route.selected.model?.host),
      source: route.selected.model?.source ?? "config"
    });
  };

  if (policy.pins?.all) {
    const source = [...taskList].sort((a, b) => Number(b.confidentiality ?? 0) - Number(a.confidentiality ?? 0))[0];
    addPinnedSlot(policy.pins.all, source, "all-pin");
  }
  for (const [role, pinId] of Object.entries(policy.pins?.roles ?? {})) {
    addPinnedSlot(pinId, roleRepresentative(taskList, role), role);
  }
  for (const [taskId, pinId] of Object.entries(policy.pins?.tasks ?? {})) {
    addPinnedSlot(pinId, taskList.find((task) => task.id === taskId), `task:${taskId}`);
  }

  const distinctModels = new Set(slots.map((slot) => slot.modelId));
  const pinnedCount = slots.filter((slot) => slot.pinned).length;
  const freeCount = slots.filter((slot) => slot.costClass === "free").length;
  const omittedRoles = representatives
    .slice(selected.length)
    .map((entry) => ({ role: entry.role, taskId: entry.task.id, reason: `pool target ${target} reached` }));

  if (slots.length < target) {
    warnings.push(`Pool target is ${target}, but only ${slots.length} adequate slot(s) were found. The scheduler will reuse models or wait; it will not fill the pool with below-bar models.`);
  }
  if (slots.length > target) {
    warnings.push(`Pinned models expanded the pool from ${target} to ${slots.length} slot(s). This is intentional: a pin is not silently dropped to satisfy the size target.`);
  }
  if (reviewNeeded && !reviewerReserve) {
    warnings.push("Review is enabled with a pool target of 1; the reviewer will share a producer slot or use a separate sequential call. Raise concurrency if you need a dedicated concurrent reviewer.");
  }
  if (shortages.some((entry) => entry.reason?.startsWith("pin_"))) {
    warnings.push("A pinned model is missing or failed privacy/budget/quality eligibility. Fix the pin or the policy; the router will not silently fall back.");
  }
  const unconfirmedHost = models.filter((model) => model.host && model.available && (model.costClass === "unknown" || model.privacy === "unknown")).length;
  if (unconfirmedHost) {
    warnings.push(`${unconfirmedHost} host-discovered model(s) have unknown billing/privacy and are excluded. Confirm provider policy before using them.`);
  }
  if (slots.some((slot) => slot.host)) {
    warnings.push("Host-discovered models are catalog entries. Confirm billing/privacy and an executor adapter before relying on them for real spending.");
  }
  if (policy.billingMode !== "allow-api") {
    warnings.push(`billingMode=${policy.billingMode}: API-metered models are excluded by policy.`);
  }

  return {
    target,
    poolSize: policy.poolSize,
    reviewNeeded,
    slots,
    shortages,
    omittedRoles,
    unfilledSlots: Math.max(0, target - slots.length),
    distinctModels: distinctModels.size,
    pinnedCount,
    freeShare: slots.length ? Math.round((freeCount / slots.length) * 1000) / 10 : 0,
    estimatedWaveCostCny: Math.round(slots.reduce((sum, slot) => sum + Number(slot.estimateCny ?? 0), 0) * 10000) / 10000,
    billingMode: policy.billingMode,
    roles: representatives.map((entry) => entry.role),
    warnings
  };
}

export function poolSummaryText(pool) {
  const lines = [
    `Model pool: target ${pool.target}, usable slots ${pool.slots.length}, distinct models ${pool.distinctModels}, free ${pool.freeShare}%`,
    `Billing mode: ${pool.billingMode}; estimated API cost per wave: ¥${pool.estimatedWaveCostCny.toFixed(4)}`
  ];
  for (const slot of pool.slots) {
    lines.push(`${slot.slot}. ${slot.role.padEnd(12)} ${slot.modelId}  ${slot.costClass}/${slot.privacy}  q=${slot.quality}/${slot.minQuality}${slot.pinned ? "  PINNED" : ""}`);
  }
  for (const shortage of pool.shortages) {
    lines.push(`! ${shortage.role}: ${shortage.reason} — ${shortage.reasonText}`);
  }
  for (const warning of pool.warnings) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}
