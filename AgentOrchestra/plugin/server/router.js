import {
  estimateCostCny,
  estimateTokens,
  modelQuality,
  modelUsableForContext,
  privacyRank,
  qualityThreshold,
  requiredPrivacyRank
} from "./registry.js";
import { clamp } from "./util.js";

function rejection(code, reason, detail = {}) {
  return { code, reason, ...detail };
}

function remainingApiBudget(state, policy) {
  const spent = Number(state.budget?.apiSpentCny ?? 0);
  const reserved = Number(state.budget?.reservedCny ?? 0);
  return Math.max(0, Number(policy.apiBudgetCny ?? 0) - spent - reserved);
}

function historyBonus(state, model) {
  const stats = state.modelStats?.[model.id];
  if (!stats || !stats.runs) return 0;
  const successRate = (stats.successes + 2) / (stats.runs + 4);
  return clamp((successRate - 0.5) * 8, -4, 4);
}

function costScoreFor(model, estimateCny, policy, remaining) {
  let score = 20;
  if (model.costClass === "free") score = 100;
  else if (model.costClass === "local") score = 94;
  else if (model.costClass === "subscription") score = 82;
  else if (model.costClass === "api") {
    const budgetRef = Math.max(1, Number(policy.apiBudgetCny ?? 0));
    const share = estimateCny / budgetRef;
    const budgetPenalty = clamp(share * 100, 0, 95);
    const absolutePenalty = clamp(estimateCny * 1.5, 0, 15);
    score = 100 - budgetPenalty - absolutePenalty;
  }
  if (policy.billingMode === "subscription" && model.costClass === "subscription") score += 4;
  if (policy.billingMode === "free-first" && model.costClass === "free") score += 4;
  return clamp(score, 5, 100);
}

export function resolvePin(task, policy) {
  return task.pinnedModel
    ?? policy.pins?.tasks?.[task.id]
    ?? policy.pins?.roles?.[task.role]
    ?? policy.pins?.all
    ?? null;
}

function candidateScore({ model, task, roles, policy, state, quality, estimateCny, remaining }) {
  const q = Number(policy.qualityPreference ?? 45) / 100;
  const costScore = costScoreFor(model, estimateCny, policy, remaining);
  const history = historyBonus(state, model);
  const latencyPenalty = clamp(Number(model.latencyMs ?? 500) / 1000 * 0.8, 0, 5);
  const score = q * quality + (1 - q) * costScore + history - latencyPenalty;
  return {
    score: Math.round(score * 100) / 100,
    quality: Math.round(quality * 10) / 10,
    costScore: Math.round(costScore * 10) / 10,
    historyBonus: Math.round(history * 10) / 10,
    latencyPenalty: Math.round(latencyPenalty * 10) / 10
  };
}

export function routeTask({
  task,
  models,
  roles,
  policy,
  state,
  promptChars = 0,
  excludeModelIds = [],
  excludeProviders = [],
  minQualityOverride = null,
  allowTriedModels = false
}) {
  if (task.owner === "human" || task.humanGate) {
    return {
      selected: null,
      candidates: [],
      rejected: [],
      minQuality: 0,
      remainingBudgetCny: remainingApiBudget(state, policy),
      reason: "human_gate",
      reasonText: "该节点是人工验收门，不分配给模型。"
    };
  }
  if (task.tier === "L0" && !policy.allowDelegateL0) {
    return {
      selected: null,
      candidates: [],
      rejected: [],
      minQuality: 0,
      remainingBudgetCny: remainingApiBudget(state, policy),
      reason: "main_model_required",
      reasonText: "L0 决策保留给主模型，不下发给子模型。"
    };
  }

  const minQuality = minQualityOverride ?? qualityThreshold(task, policy);
  const excludedModels = new Set((excludeModelIds ?? []).filter(Boolean));
  const excludedProviders = new Set((excludeProviders ?? []).filter(Boolean));
  const remaining = remainingApiBudget(state, policy);
  const candidates = [];
  const rejected = [];
  const pinId = resolvePin(task, policy);
  let candidateModels = models;
  if (pinId) {
    const pinned = models.find((model) => model.id === pinId);
    if (!pinned) {
      return {
        selected: null,
        candidates: [],
        rejected: [],
        minQuality,
        remainingBudgetCny: remaining,
        reason: "pin_missing",
        reasonText: `固定模型 ${pinId} 不在当前模型目录中。`,
        pinId
      };
    }
    candidateModels = [pinned];
  }

  for (const model of candidateModels) {
    const tokens = estimateTokens(task, model, promptChars);
    const estimateCny = estimateCostCny(model, tokens);
    const reject = (code, reason) => rejected.push(rejection(code, reason, { modelId: model.id, provider: model.provider }));

    if (!model.available) {
      reject("unavailable", "模型当前不可用");
      continue;
    }
    if (!allowTriedModels && excludedModels.has(model.id) && model.id !== pinId) {
      reject("previously_tried", "本任务已尝试过该模型");
      continue;
    }
    if (excludedProviders.has(model.provider)) {
      reject("provider_excluded", "按审查/升级策略排除该平台");
      continue;
    }
    if (policy.providerAllowlist?.length && !policy.providerAllowlist.includes(model.provider)) {
      reject("provider_not_allowed", "平台不在允许列表");
      continue;
    }
    if (model.privacy === "unknown" && !policy.allowUnknownPrivacy) {
      reject("privacy_unknown", "隐私等级未知，默认不发送任务");
      continue;
    }
    const requiredRank = requiredPrivacyRank(task.confidentiality);
    if (privacyRank(model.privacy) < requiredRank) {
      reject("privacy_blocked", `保密等级 ${task.confidentiality} 需要 ${requiredRank} 级数据边界，模型仅 ${privacyRank(model.privacy)} 级`);
      continue;
    }
    if (model.costClass === "unknown" && !policy.allowUnknownCost) {
      reject("cost_unknown", "成本等级未知，默认不使用");
      continue;
    }
    if (model.costClass === "api" && policy.billingMode !== "allow-api") {
      reject("billing_mode", `billingMode=${policy.billingMode} 禁止额外 API 计费模型`);
      continue;
    }
    if (model.costClass === "api") {
      if (policy.zeroExtraPaid) {
        reject("zero_extra_paid", "已启用严格零额外付费");
        continue;
      }
      if (Number(policy.apiBudgetCny ?? 0) <= 0) {
        reject("no_api_budget", "未设置额外 API 预算");
        continue;
      }
      if (estimateCny > remaining) {
        reject("budget_exceeded", `预计 ¥${estimateCny.toFixed(4)} 超过剩余预算 ¥${remaining.toFixed(4)}`);
        continue;
      }
      if (Number(model.inputCostCnyPerMTok ?? 0) === 0 && Number(model.outputCostCnyPerMTok ?? 0) === 0) {
        reject("api_price_unknown", "API 模型未配置价格，无法验证预算");
        continue;
      }
    }
    if (!modelUsableForContext(model, tokens)) {
      reject("context_too_small", `预计 ${tokens.total} tokens 超过模型上下文安全线`);
      continue;
    }
    const quality = modelQuality(model, task, roles);
    if (quality < minQuality) {
      reject("quality_below_bar", `能力拟合 ${quality.toFixed(1)} 低于最低验收线 ${minQuality}`);
      continue;
    }
    const scored = candidateScore({ model, task, roles, policy, state, quality, estimateCny, remaining });
    candidates.push({
      modelId: model.id,
      provider: model.provider,
      label: model.label,
      costClass: model.costClass,
      privacy: model.privacy,
      quality: scored.quality,
      score: scored.score,
      costScore: scored.costScore,
      historyBonus: scored.historyBonus,
      latencyPenalty: scored.latencyPenalty,
      estimateCny,
      estimateTokens: tokens,
      pinned: Boolean(pinId && model.id === pinId),
      model
    });
  }

  const q = Number(policy.qualityPreference ?? 45) / 100;
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (q >= 0.5) return b.quality - a.quality;
    return a.estimateCny - b.estimateCny;
  });

  if (!candidates.length) {
    if (pinId) {
      return {
        selected: null,
        candidates: [],
        rejected,
        minQuality,
        remainingBudgetCny: remaining,
        reason: "pin_ineligible",
        reasonText: `固定模型 ${pinId} 未通过准入：${rejected.map((item) => item.reason).join("；") || "未知原因"}`,
        pinId
      };
    }
    const codes = new Set(rejected.map((item) => item.code));
    let reason = "no_eligible_model";
    let reasonText = "没有满足条件的可用模型。";
    if (codes.has("billing_mode")) {
      reason = "billing_mode_blocked";
      reasonText = `billingMode=${policy.billingMode} 阻止了额外 API 计费模型；任务可等待预算/策略调整后继续。`;
    } else if (codes.has("zero_extra_paid") || codes.has("no_api_budget") || codes.has("budget_exceeded")) {
      reason = "budget_exhausted";
      reasonText = "预算/零额外付费策略阻止了可用模型；任务可等待预算调整后继续。";
    } else if (codes.has("privacy_blocked") || codes.has("privacy_unknown")) {
      reason = "privacy_blocked";
      reasonText = "保密等级限制了可用模型；不要把敏感内容降级发给公共模型。";
    } else if (codes.has("quality_below_bar")) {
      reason = "quality_bar_not_met";
      reasonText = "现有模型低于最低能力线；应升级模型、由主模型处理，或调整任务范围。";
    } else if (codes.has("context_too_small")) {
      reason = "context_too_small";
      reasonText = "任务上下文超过所有候选模型的安全线；需要拆分上下文。";
    }
    return { selected: null, candidates: [], rejected, minQuality, remainingBudgetCny: remaining, reason, reasonText, pinId };
  }

  const best = candidates[0];
  return {
    selected: {
      ...best,
      minQuality,
      pinned: Boolean(pinId),
      scoreBreakdown: {
        qualityPreference: policy.qualityPreference,
        quality: best.quality,
        costScore: best.costScore,
        historyBonus: best.historyBonus,
        latencyPenalty: best.latencyPenalty
      }
    },
    candidates,
    rejected,
    minQuality,
    remainingBudgetCny: remaining,
    reason: null,
    reasonText: null,
    pinId
  };
}

export function routeReviewer({
  task,
  models,
  roles,
  policy,
  state,
  producerModel,
  producerProvider,
  promptChars = 0
}) {
  const reviewTask = {
    ...task,
    role: "reviewer",
    kind: "review",
    tier: "L1",
    owner: "orchestra",
    humanGate: false,
    deps: [],
    difficulty: Math.max(3, Math.min(5, Number(task.difficulty ?? 3))),
    requiredCapabilities: ["review", "reasoning"],
    acceptance: {
      ...task.acceptance,
      critical: false,
      skipModelReview: true
    }
  };
  const base = {
    task: reviewTask,
    models,
    roles,
    policy,
    state,
    promptChars,
    excludeModelIds: producerModel ? [producerModel.id] : [],
    minQualityOverride: Math.max(55, qualityThreshold(reviewTask, policy))
  };
  const reviewerPin = policy.pins?.roles?.reviewer ?? policy.pins?.all ?? null;
  if (reviewerPin) {
    const pinnedRoute = routeTask({ ...base, excludeProviders: [] });
    return {
      ...pinnedRoute,
      crossProvider: false,
      fallbackReason: "Reviewer is pinned explicitly; cross-provider preference is secondary."
    };
  }
  if (policy.requireCrossProviderReview && producerProvider) {
    const cross = routeTask({ ...base, excludeProviders: [producerProvider] });
    if (cross.selected) return { ...cross, crossProvider: true };
    const fallback = routeTask({ ...base, excludeProviders: [] });
    return { ...fallback, crossProvider: false, fallbackReason: "没有可用的跨平台审查模型，已回退到同平台但不同模型。" };
  }
  const result = routeTask({ ...base, excludeProviders: [] });
  return { ...result, crossProvider: false };
}

export function routePreviewText(route) {
  if (!route.selected) {
    return route.reasonText ?? "无可用模型";
  }
  const selected = route.selected;
  return [
    `${selected.label} (${selected.modelId})`,
    `平台 ${selected.provider} · 成本 ${selected.costClass} · 隐私 ${selected.privacy}`,
    `能力拟合 ${selected.quality} / 最低线 ${route.minQuality}`,
    `综合分 ${selected.score} = 质量 ${selected.quality} × ${selected.scoreBreakdown.qualityPreference}% + 成本 ${selected.costScore} × ${100 - selected.scoreBreakdown.qualityPreference}%`,
    `预计成本 ¥${selected.estimateCny.toFixed(4)} · 剩余 API 预算 ¥${route.remainingBudgetCny.toFixed(4)}`
  ].join("\n");
}
