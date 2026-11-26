import { clamp } from "./util.js";

const CAPABILITY_NAMES = ["reasoning", "coding", "research", "writing", "design", "review", "tools", "multimodal", "speed"];

export function roleWeights(task, roles) {
  const required = Array.isArray(task.requiredCapabilities) ? task.requiredCapabilities : [];
  if (required.length) {
    const pairs = required.map((entry) => {
      if (typeof entry === "string") return [entry, 1];
      if (entry && typeof entry === "object") {
        const name = entry.name ?? entry.capability;
        return [name, Number(entry.weight ?? 1)];
      }
      return [null, 0];
    }).filter(([name, weight]) => CAPABILITY_NAMES.includes(name) && weight > 0);
    if (pairs.length) {
      const total = pairs.reduce((sum, [, weight]) => sum + weight, 0);
      return Object.fromEntries(pairs.map(([name, weight]) => [name, weight / total]));
    }
  }
  const role = roles?.[task.role] ?? roles?.generalist;
  const weights = role?.weights ?? { reasoning: 0.5, writing: 0.3, tools: 0.2 };
  const entries = Object.entries(weights).filter(([name, weight]) => CAPABILITY_NAMES.includes(name) && Number(weight) > 0);
  const total = entries.reduce((sum, [, weight]) => sum + Number(weight), 0) || 1;
  return Object.fromEntries(entries.map(([name, weight]) => [name, Number(weight) / total]));
}

export function modelQuality(model, task, roles) {
  const weights = roleWeights(task, roles);
  let raw = 0;
  for (const [name, weight] of Object.entries(weights)) {
    raw += Number(model.capabilities?.[name] ?? 0) * weight;
  }
  const penalty = Math.max(0, Number(task.difficulty ?? 2) - 1) * 7;
  return clamp(raw - penalty, 0, 100);
}

export function qualityThreshold(task, _policy = {}) {
  const tierBonus = task.tier === "L0" ? 18 : task.tier === "L1" ? 8 : 0;
  const criticalBonus = task.acceptance?.critical ? 4 : 0;
  return clamp(24 + Number(task.difficulty ?? 2) * 5 + tierBonus + criticalBonus, 0, 95);
}

export function privacyRank(privacy) {
  if (privacy === "local") return 3;
  if (privacy === "trusted") return 2;
  if (privacy === "public") return 1;
  return 0;
}

export function requiredPrivacyRank(confidentiality) {
  return clamp(Number(confidentiality ?? 0) + 1, 1, 3);
}

export function estimateTokens(task, model, promptChars = 0) {
  const contextLimit = Number(model?.contextTokens ?? 128000);
  const estimatedInput = task.estimateTokens?.input ?? clamp(1000 + Number(promptChars) / 2.8, 1200, Math.min(contextLimit * 0.65, 60000));
  const estimatedOutput = task.estimateTokens?.output ?? clamp(1000 + Number(task.difficulty ?? 2) * 550, 800, 8000);
  return {
    input: Math.round(estimatedInput),
    output: Math.round(estimatedOutput),
    total: Math.round(estimatedInput + estimatedOutput)
  };
}

export function estimateCostCny(model, tokens) {
  const input = Number(tokens?.input ?? 0);
  const output = Number(tokens?.output ?? 0);
  return (
    (input / 1_000_000) * Number(model.inputCostCnyPerMTok ?? 0) +
    (output / 1_000_000) * Number(model.outputCostCnyPerMTok ?? 0)
  );
}

export function modelCostClassLabel(costClass) {
  const labels = {
    free: "免费",
    local: "本地算力",
    subscription: "订阅额度",
    api: "额外 API",
    unknown: "未知"
  };
  return labels[costClass] ?? costClass;
}

export function modelUsableForContext(model, tokens) {
  return Number(tokens?.total ?? 0) <= Number(model.contextTokens ?? 0) * 0.82;
}

export function capabilitySummary(model) {
  return Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, Number(model.capabilities?.[name] ?? 0)]));
}
