import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicWriteJson,
  deepMerge,
  ensureDir,
  expandEnv,
  isPlainObject,
  readJson
} from "./util.js";
import { applyHostPolicy, hostModelsFromFile } from "./host-models.js";

export const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const COST_CLASSES = new Set(["free", "local", "subscription", "api", "unknown"]);
export const PRIVACY_LEVELS = new Set(["local", "trusted", "public", "unknown"]);

export function resolveRoot(explicitRoot = null) {
  if (explicitRoot) return path.resolve(explicitRoot);
  if (process.env.AGENTORCHESTRA_ROOT) return path.resolve(process.env.AGENTORCHESTRA_ROOT);
  return TOOL_ROOT;
}

export function resolveConfigDir(root) {
  const local = path.join(root, "config");
  if (fs.existsSync(path.join(local, "models.json"))) return local;
  return path.join(TOOL_ROOT, "config");
}

function mergeModelFiles(base, addition) {
  const incoming = Array.isArray(addition) ? addition : addition?.models ?? [];
  const byId = new Map(base.map((model) => [model.id, model]));
  for (const model of incoming) {
    if (!model?.id) continue;
    const previous = byId.get(model.id) ?? {};
    byId.set(model.id, deepMerge(previous, model));
  }
  return [...byId.values()];
}

function normalizeCapabilities(value) {
  const names = ["reasoning", "coding", "research", "writing", "design", "review", "tools", "multimodal", "speed"];
  const output = {};
  for (const name of names) {
    const number = Number(value?.[name] ?? 0);
    output[name] = Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
  }
  return output;
}

export function normalizeModel(raw, source = "config") {
  if (!raw?.id) throw new Error("Model entry is missing id");
  const costClass = COST_CLASSES.has(raw.costClass) ? raw.costClass : "unknown";
  const privacy = PRIVACY_LEVELS.has(raw.privacy) ? raw.privacy : "unknown";
  return {
    id: String(raw.id),
    provider: String(raw.provider ?? "unknown"),
    remoteModel: raw.remoteModel ? String(raw.remoteModel) : null,
    label: String(raw.label ?? raw.id),
    costClass,
    privacy,
    available: raw.available !== false,
    contextTokens: Math.max(1000, Number(raw.contextTokens ?? 128000)),
    inputCostCnyPerMTok: Math.max(0, Number(raw.inputCostCnyPerMTok ?? 0)),
    outputCostCnyPerMTok: Math.max(0, Number(raw.outputCostCnyPerMTok ?? 0)),
    latencyMs: Math.max(0, Number(raw.latencyMs ?? 500)),
    capabilities: normalizeCapabilities(raw.capabilities),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    notes: raw.notes ? String(raw.notes) : "",
    baseURL: raw.baseURL ? String(raw.baseURL) : null,
    apiKeyEnv: raw.apiKeyEnv ? String(raw.apiKeyEnv) : null,
    source,
    host: Boolean(raw.host),
    hostSource: raw.hostSource ?? null,
    hostProviderID: raw.hostProviderID ?? null,
    costHint: raw.costHint ?? null,
    executor: raw.executor ?? null,
    raw
  };
}

export function loadModels(root, { includeDiscovered = true } = {}) {
  const configDir = resolveConfigDir(root);
  const baseFile = path.join(configDir, "models.json");
  const base = readJson(baseFile);
  let models = mergeModelFiles([], base);
  let settings = { ...(base.settings ?? {}) };

  const localFile = path.join(configDir, "models.local.json");
  if (fs.existsSync(localFile)) {
    const local = readJson(localFile);
    models = mergeModelFiles(models, local);
    settings = { ...settings, ...(local.settings ?? {}) };
  }

  if (includeDiscovered) {
    const discoveredFile = path.join(root, ".orchestra", "models.discovered.json");
    if (fs.existsSync(discoveredFile)) {
      const discovered = readJson(discoveredFile);
      const known = new Set(models.map((model) => model.id));
      const additions = (discovered.models ?? []).filter((model) => !known.has(model.id));
      models = mergeModelFiles(models, additions);
      settings = { ...settings, ...(discovered.settings ?? {}) };
    }
  }

  let hostModels = [];
  const userHostPolicyFile = path.join(root, ".orchestra", "host-policy.json");
  const defaultHostPolicyFile = path.join(configDir, "host-policy.json");
  const hostPolicy = fs.existsSync(userHostPolicyFile)
    ? readJson(userHostPolicyFile)
    : fs.existsSync(defaultHostPolicyFile)
      ? readJson(defaultHostPolicyFile)
      : { providers: {} };
  if (includeDiscovered) {
    hostModels = applyHostPolicy(hostModelsFromFile(root), hostPolicy);
    const known = new Set(models.map((model) => model.id));
    const additions = hostModels.filter((model) => !known.has(model.id));
    models = mergeModelFiles(models, additions);
  }

  const normalized = models.map((model) => normalizeModel(model, model.source ?? "config"));
  const ids = new Set();
  for (const model of normalized) {
    if (ids.has(model.id)) throw new Error(`Duplicate model id: ${model.id}`);
    ids.add(model.id);
  }
  return { models: normalized, settings, hostModels, hostPolicy };
}

export function saveDiscoveredModels(root, models, settings = {}) {
  const file = path.join(root, ".orchestra", "models.discovered.json");
  ensureDir(path.dirname(file));
  atomicWriteJson(file, {
    generatedAt: new Date().toISOString(),
    note: "Discovered models have conservative metadata. Edit config/models.local.json to override cost, privacy and capability scores.",
    settings,
    models: models.map((model) => model.raw ?? model)
  });
  return file;
}

export function loadConfig(root, options = {}) {
  const configDir = resolveConfigDir(root);
  const policyFile = path.join(configDir, "policy.json");
  const rolesFile = path.join(configDir, "roles.json");
  const providersFile = path.join(configDir, "providers.json");
  const policyDefaults = readJson(policyFile);
  const rolesDoc = readJson(rolesFile);
  const providersDoc = readJson(providersFile);
  const { models, settings, hostModels, hostPolicy } = loadModels(root, options);
  const providers = expandEnv(providersDoc.providers ?? {});
  return {
    root,
    toolRoot: TOOL_ROOT,
    configDir,
    policyDefaults,
    roles: rolesDoc.roles ?? {},
    providers,
    models,
    hostModels: hostModels ?? [],
    hostPolicy: hostPolicy ?? { providers: {} },
    settings
  };
}

export function loadPlanFile(root, file) {
  const candidates = [
    path.resolve(file),
    path.join(root, file),
    path.join(TOOL_ROOT, file)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return readJson(candidate);
  }
  throw new Error(`Plan file not found: ${file}`);
}

export function resolveProviderForModel(model, providerConfigs) {
  const direct = providerConfigs?.[model.provider];
  if (direct) return { ...direct };
  if (isPlainObject(model.raw?.providerConfig)) return { ...model.raw.providerConfig };
  return null;
}
