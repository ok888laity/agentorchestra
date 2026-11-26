import fs from "node:fs";
import path from "node:path";
import { ensureDir, nowIso, readJson, atomicWriteJson } from "./util.js";

export const HOST_MODELS_FILE = path.join(".orchestra", "host-models.json");

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function numericLeaves(value, output = []) {
  if (typeof value === "number") output.push(value);
  else if (Array.isArray(value)) for (const item of value) numericLeaves(item, output);
  else if (value && typeof value === "object") for (const item of Object.values(value)) numericLeaves(item, output);
  return output;
}

function capabilityScores(raw = {}) {
  if (raw.reasoning !== undefined || raw.coding !== undefined || raw.design !== undefined) {
    return {
      reasoning: numberOr(raw.reasoning, 50),
      coding: numberOr(raw.coding, 50),
      research: numberOr(raw.research, 50),
      writing: numberOr(raw.writing, 50),
      design: numberOr(raw.design, 50),
      review: numberOr(raw.review, 50),
      tools: numberOr(raw.tools, 50),
      multimodal: numberOr(raw.multimodal, 0),
      speed: numberOr(raw.speed, 60)
    };
  }
  return {
    reasoning: raw.reasoning ? 70 : 50,
    coding: raw.toolcall ? 60 : 50,
    research: 50,
    writing: 50,
    design: 50,
    review: 55,
    tools: raw.toolcall ? 70 : 40,
    multimodal: raw.attachment ? 60 : 0,
    speed: 60
  };
}

export function normalizeHostModel(raw = {}, meta = {}) {
  const providerID = String(raw.providerID ?? raw.provider ?? meta.provider ?? "host");
  const modelID = String(raw.modelID ?? raw.id ?? raw.model ?? raw.remoteModel ?? "");
  if (!modelID) throw new Error("Host model entry is missing id");
  const source = String(raw.source ?? meta.source ?? "host");
  const executor = String(raw.executor ?? meta.executor ?? "opencode");
  const remoteModel = String(raw.remoteModel ?? `${providerID}/${modelID}`);
  const registryId = String(raw.registryId ?? `host:${source}:${remoteModel}`);
  const rawCost = raw.cost ?? {};
  const costValues = numericLeaves(rawCost);
  const costHint = costValues.length ? (costValues.some((value) => value > 0) ? "nonzero" : "zero") : "unknown";
  const inferredFree = costHint === "zero";
  const costClass = ["free", "local", "subscription", "api", "unknown"].includes(raw.billing ?? meta.billing)
    ? (raw.billing ?? meta.billing)
    : inferredFree
      ? "free"
      : "unknown";
  const privacy = ["local", "trusted", "public", "unknown"].includes(raw.privacy ?? meta.privacy)
    ? (raw.privacy ?? meta.privacy)
    : "unknown";
  const usdToCny = numberOr(meta.usdToCny, 7.2);
  const inputCost = raw.inputCostCnyPerMTok !== undefined
    ? numberOr(raw.inputCostCnyPerMTok, 0)
    : rawCost.input !== undefined
      ? numberOr(rawCost.input, 0) * 1_000_000 * usdToCny
      : 0;
  const outputCost = raw.outputCostCnyPerMTok !== undefined
    ? numberOr(raw.outputCostCnyPerMTok, 0)
    : rawCost.output !== undefined
      ? numberOr(rawCost.output, 0) * 1_000_000 * usdToCny
      : 0;
  return {
    id: registryId,
    provider: executor,
    hostProviderID: providerID,
    remoteModel,
    label: String(raw.label ?? raw.name ?? remoteModel),
    costClass,
    privacy,
    costHint,
    available: raw.available !== false,
    contextTokens: Math.max(1000, numberOr(raw.contextTokens ?? raw.limit?.context, 128000)),
    inputCostCnyPerMTok: Math.max(0, inputCost),
    outputCostCnyPerMTok: Math.max(0, outputCost),
    latencyMs: Math.max(0, numberOr(raw.latencyMs, 700)),
    capabilities: capabilityScores(raw.capabilities),
    tags: ["host", source, ...(Array.isArray(raw.tags) ? raw.tags.map(String) : [])],
    notes: `Discovered from ${source} host catalogue. Billing/privacy require explicit confirmation before cost-sensitive use.`,
    host: true,
    hostSource: source,
    executor,
    source: "host"
  };
}

export function syncHostModels(root, { models = [], source = "host", billing = "unknown", privacy = "unknown", executor = "opencode" } = {}) {
  const existing = readHostModels(root);
  const effectiveBilling = billing && billing !== "unknown" ? billing : existing?.billing ?? "unknown";
  const effectivePrivacy = privacy && privacy !== "unknown" ? privacy : existing?.privacy ?? "unknown";
  const effectiveExecutor = executor && executor !== "unknown" ? executor : existing?.executor ?? "opencode";
  const normalized = (models ?? []).map((model) => normalizeHostModel(model, {
    source,
    billing: effectiveBilling,
    privacy: effectivePrivacy,
    executor: effectiveExecutor
  }));
  const dir = path.join(root, ".orchestra");
  ensureDir(dir);
  const file = path.join(root, HOST_MODELS_FILE);
  atomicWriteJson(file, {
    schema: 1,
    generatedAt: nowIso(),
    source,
    billing: effectiveBilling,
    privacy: effectivePrivacy,
    executor: effectiveExecutor,
    count: normalized.length,
    models: normalized
  });
  return { file, count: normalized.length, models: normalized, billing: effectiveBilling, privacy: effectivePrivacy, executor: effectiveExecutor };
}

export function applyHostPolicy(models, policyDoc = {}) {
  const rules = policyDoc?.providers ?? {};
  return (models ?? []).map((model) => {
    const providerID = model.hostProviderID
      ?? model.providerID
      ?? String(model.remoteModel ?? "").split("/")[0];
    const rule = rules[providerID];
    if (!rule) return model;
    if (rule.enabled === false) {
      return {
        ...model,
        available: false,
        notes: `${model.notes ?? ""} ${rule.reason ?? `Provider ${providerID} disabled by host policy.`}`.trim()
      };
    }
    const free = model.costHint === "zero" || /free/i.test(model.remoteModel ?? "") || /free/i.test(model.label ?? "");
    const haystack = `${model.remoteModel ?? ""} ${model.label ?? ""}`.toLowerCase();
    if (Array.isArray(rule.allowPatterns) && rule.allowPatterns.length
      && !rule.allowPatterns.some((pattern) => haystack.includes(String(pattern).toLowerCase()))) {
      return {
        ...model,
        available: false,
        notes: `${model.notes ?? ""} ${rule.reason ?? `Model is outside the allowed ${providerID} patterns.`}`.trim()
      };
    }
    if (rule.freeOnly && !free) {
      return {
        ...model,
        available: false,
        notes: `${model.notes ?? ""} ${rule.reason ?? `Only free ${providerID} models are enabled.`}`.trim()
      };
    }
    let costClass = model.costClass;
    if (rule.billing === "auto") costClass = free ? "free" : (rule.paidBilling ?? "subscription");
    else if (rule.billing) costClass = rule.billing;
    else if (rule.freeOnly && free) costClass = "free";
    return {
      ...model,
      costClass,
      privacy: rule.privacy ?? model.privacy
    };
  });
}

export function confirmHostModels(root, { billing, privacy, executor = null, source = null } = {}) {
  const existing = readHostModels(root);
  if (!existing?.models?.length) throw new Error("No host models have been discovered yet. Sync them first.");
  if (!billing || !["free", "local", "subscription", "api"].includes(billing)) {
    throw new Error("billing must be confirmed as free, local, subscription or api");
  }
  if (!privacy || !["local", "trusted", "public"].includes(privacy)) {
    throw new Error("privacy must be confirmed as local, trusted or public");
  }
  return syncHostModels(root, {
    models: existing.models,
    source: source ?? existing.source ?? "host",
    billing,
    privacy,
    executor: executor ?? existing.executor ?? "opencode"
  });
}

export function readHostModels(root) {
  const file = path.join(root, HOST_MODELS_FILE);
  if (!fs.existsSync(file)) return null;
  return readJson(file, null);
}

export function hostModelsFromFile(root) {
  return readHostModels(root)?.models ?? [];
}
