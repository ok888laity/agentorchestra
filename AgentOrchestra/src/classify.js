import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readHostModels } from "./host-models.js";
import { readJson, safeJoin } from "./util.js";

const LOCAL_PROVIDERS = new Set([
  "ollama", "ollama-cloud", "lmstudio", "llama.cpp", "llamacpp", "vllm", "localai", "local", "koboldcpp", "text-generation-webui"
]);
const FIRST_PARTY = new Set([
  "openai", "anthropic", "google", "gemini", "opencode", "opencode-go", "azure", "bedrock", "vertex", "mistral", "groq", "deepseek", "fireworks", "together"
]);

function safeRead(file) {
  try {
    return readJson(file, null);
  } catch {
    return null;
  }
}

export function readCodexAuthMetadata() {
  const file = path.join(os.homedir(), ".codex", "auth.json");
  const doc = safeRead(file);
  if (!doc) return { available: false, mode: "unknown" };
  return {
    available: true,
    mode: String(doc.auth_mode ?? "unknown"),
    hasApiKey: Boolean(doc.OPENAI_API_KEY),
    hasOAuthTokens: Boolean(doc.tokens?.access_token),
    note: "Only metadata is read; token values are never returned."
  };
}

function isLocalEndpoint(value) {
  const raw = String(value ?? "");
  if (!raw) return false;
  try {
    const host = new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.toLowerCase();
    if (host === "localhost" || host === "::1" || host === "0.0.0.0" || host === "127.0.0.1") return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    const match = host.match(/^172\.(\d+)\./);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
    return false;
  } catch {
    return false;
  }
}

function providerIdOf(model) {
  return model.hostProviderID
    ?? model.providerID
    ?? String(model.remoteModel ?? "").split("/")[0]
    ?? "unknown";
}

function confidenceLabel(value) {
  if (value >= 0.85) return "high";
  if (value >= 0.55) return "medium";
  return "low";
}

function recommendBilling({ provider, models, providerMeta, codexAuth }) {
  const free = models.filter((m) => m.costClass === "free" || m.costHint === "zero" || /free/i.test(m.remoteModel ?? "")).length;
  const paid = models.filter((m) => m.costClass === "api" || m.costHint === "nonzero" || (m.inputCostCnyPerMTok ?? 0) > 0).length;
  const endpoint = providerMeta?.baseURLHost ?? "";
  const local = LOCAL_PROVIDERS.has(provider.toLowerCase()) || isLocalEndpoint(endpoint);
  const codexSubscription = codexAuth?.mode === "chatgpt" && codexAuth?.hasOAuthTokens;

  if (local) {
    return { billing: "local", confidence: 0.96, evidence: ["local provider id or private/loopback endpoint"], free, paid };
  }
  if (codexSubscription && provider.toLowerCase() === "codex") {
    return { billing: "subscription", confidence: 0.9, evidence: ["Codex auth_mode=chatgpt with OAuth tokens"], free, paid };
  }
  if (codexAuth?.mode === "apikey" && provider.toLowerCase() === "codex") {
    return { billing: "api", confidence: 0.88, evidence: ["Codex auth_mode=apikey"], free, paid };
  }
  if (free > 0 && paid === 0) {
    return { billing: "free", confidence: 0.85, evidence: ["catalog price is zero for all observed models"], free, paid };
  }
  if (paid > 0 && free === 0) {
    return { billing: "api", confidence: 0.7, evidence: ["catalog price is non-zero; no free-tier signal"], free, paid };
  }
  if (paid > 0 && free > 0) {
    return { billing: "subscription", confidence: 0.55, evidence: ["mixed free/paid catalogue; likely bundled or credit plan"], free, paid };
  }
  return { billing: "unknown", confidence: 0.2, evidence: ["no reliable billing signal"], free, paid };
}

function recommendPrivacy({ provider, providerMeta, billing }) {
  const endpoint = providerMeta?.baseURLHost ?? "";
  const local = LOCAL_PROVIDERS.has(provider.toLowerCase()) || isLocalEndpoint(endpoint);
  if (local) {
    return {
      suggested: "local",
      confidence: 0.96,
      requiresConfirmation: false,
      evidence: ["loopback/private endpoint or known local runtime"]
    };
  }
  if (FIRST_PARTY.has(provider.toLowerCase())) {
    return {
      suggested: "unknown",
      trustedCandidate: true,
      confidence: 0.45,
      requiresConfirmation: true,
      evidence: ["remote first-party provider; data policy must be confirmed by the user", "technical metadata cannot prove trusted handling"]
    };
  }
  return {
    suggested: billing === "free" ? "public" : "unknown",
    confidence: 0.35,
    requiresConfirmation: billing !== "free",
    evidence: ["remote provider with no verified data policy"]
  };
}

export function classifyHostModels(root, options = {}) {
  const doc = readHostModels(root);
  const models = (doc?.models ?? []).filter((model) => model.host || model.hostProviderID || String(model.remoteModel ?? "").includes("/"));
  const metaDoc = safeRead(path.join(root, ".orchestra", "host-providers.json"));
  const providerMeta = metaDoc?.providers ?? {};
  const codexAuth = options.codexAuth ?? readCodexAuthMetadata();
  const policy = safeRead(path.join(root, ".orchestra", "host-policy.json"))
    ?? safeRead(path.join(root, "config", "host-policy.json"))
    ?? { providers: {} };

  const grouped = new Map();
  for (const model of models) {
    const id = providerIdOf(model);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(model);
  }

  const groups = [...grouped.entries()].map(([provider, groupModels]) => {
    const meta = providerMeta[provider] ?? {};
    const billing = recommendBilling({ provider, models: groupModels, providerMeta: meta, codexAuth });
    const privacy = recommendPrivacy({ provider, providerMeta: meta, billing: billing.billing });
    const current = policy.providers?.[provider] ?? {};
    const billingResolved = Boolean(current.billing) && current.billing !== "unknown";
    const privacyResolved = Boolean(current.privacy) && current.privacy !== "unknown";
    const needsUserChoice = current.userChoice === true
      ? false
      : (!billingResolved && billing.confidence < 0.55)
        || (!privacyResolved && privacy.requiresConfirmation)
        || current.enabled === false;
    return {
      provider,
      modelCount: groupModels.length,
      executor: [...new Set(groupModels.map((m) => m.executor ?? doc?.executor).filter(Boolean))],
      baseURLHost: meta.baseURLHost ?? null,
      billing: {
        suggested: billing.billing,
        confidence: confidenceLabel(billing.confidence),
        confidenceScore: billing.confidence,
        evidence: billing.evidence,
        freeModels: billing.free,
        pricedModels: billing.paid
      },
      privacy: {
        suggested: privacy.suggested,
        trustedCandidate: Boolean(privacy.trustedCandidate),
        confidence: confidenceLabel(privacy.confidence),
        confidenceScore: privacy.confidence,
        requiresConfirmation: privacy.requiresConfirmation,
        evidence: privacy.evidence
      },
      currentPolicy: current,
      needsUserChoice
    };
  });

  groups.sort((a, b) => Number(b.needsUserChoice) - Number(a.needsUserChoice) || b.modelCount - a.modelCount);
  return {
    generatedAt: new Date().toISOString(),
    source: doc?.source ?? "none",
    codexAuth: { mode: codexAuth.mode, hasApiKey: Boolean(codexAuth.hasApiKey), hasOAuthTokens: Boolean(codexAuth.hasOAuthTokens) },
    groups,
    choicesRequired: groups.filter((group) => group.needsUserChoice).map((group) => ({
      provider: group.provider,
      question: `Confirm billing and privacy for provider ${group.provider}`,
      suggestedBilling: group.billing.suggested,
      suggestedPrivacy: group.privacy.suggested,
      trustedCandidate: group.privacy.trustedCandidate
    }))
  };
}

export function classificationSummaryText(report) {
  const lines = [
    `Host classification (${report.source || "no host catalogue"}); Codex auth=${report.codexAuth?.mode ?? "unknown"}`,
    "",
    "Provider | Models | Billing suggestion | Confidence | Privacy suggestion | Needs choice"
  ];
  for (const group of report.groups) {
    lines.push(
      `${group.provider} | ${group.modelCount} | ${group.billing.suggested} | ${group.billing.confidence} | ` +
      `${group.privacy.suggested}${group.privacy.trustedCandidate ? " (trusted candidate)" : ""} | ${group.needsUserChoice ? "YES" : "no"}`
    );
    for (const evidence of [...group.billing.evidence, ...group.privacy.evidence]) lines.push(`  - ${evidence}`);
  }
  if (report.choicesRequired.length) {
    lines.push("");
    lines.push("Choices needed:");
    for (const choice of report.choicesRequired) {
      lines.push(`- ${choice.provider}: billing=${choice.suggestedBilling}, privacy=${choice.suggestedPrivacy}${choice.trustedCandidate ? ", trusted candidate requires confirmation" : ""}`);
    }
  }
  return lines.join("\n");
}

export function writeProviderPolicy(root, provider, patch) {
  const dir = path.join(root, ".orchestra");
  ensureDirSafe(dir);
  const file = path.join(dir, "host-policy.json");
  const doc = safeRead(file) ?? { providers: {} };
  doc.providers = doc.providers ?? {};
  const current = doc.providers[provider] ?? { enabled: true };
  doc.providers[provider] = { ...current, ...patch, userChoice: true };
  atomicWriteSafe(file, doc);
  return doc.providers[provider];
}

function atomicWriteSafe(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  ensureDirSafe(path.dirname(file));
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function ensureDirSafe(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
