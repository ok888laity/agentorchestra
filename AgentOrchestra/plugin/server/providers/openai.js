import { estimateCostCny } from "../registry.js";
import { normalizeModel } from "../config.js";
import { nowIso, tail } from "../util.js";

function joinUrl(baseURL, suffix) {
  return `${String(baseURL).replace(/\/+$/, "")}${suffix}`;
}

function parseArtifactBlocks(output) {
  const artifacts = [];
  const pattern = /```(?:artifact|file)\s+(?:path=)?([^\s`]+)\s*\n([\s\S]*?)```/gi;
  for (const match of String(output ?? "").matchAll(pattern)) {
    artifacts.push({ path: match[1].trim(), content: match[2] });
  }
  return artifacts;
}

export class OpenAiCompatibleProvider {
  constructor({ name, config = {}, settings = {} }) {
    this.name = name;
    this.config = config;
    this.settings = settings;
  }

  resolve(model) {
    const baseURL = model.baseURL || model.raw?.baseURL || this.config.baseURL;
    const apiKeyEnv = model.apiKeyEnv || model.raw?.apiKeyEnv || this.config.apiKeyEnv;
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : null;
    const requiresKey = this.config.requiresKey !== false;
    return {
      baseURL,
      apiKey,
      apiKeyEnv,
      requiresKey,
      remoteModel: model.remoteModel || model.id.split("/").slice(1).join("/") || model.id
    };
  }

  async probe(model) {
    const resolved = this.resolve(model ?? { raw: {}, id: "probe", baseURL: null, apiKeyEnv: null });
    if (!resolved.baseURL) return { available: false, detail: "baseURL is not configured" };
    if (resolved.requiresKey && !resolved.apiKey) {
      return { available: false, detail: `missing env ${resolved.apiKeyEnv ?? "(none configured)"}` };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(joinUrl(resolved.baseURL, "/models"), {
        headers: resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {},
        signal: controller.signal
      });
      if (!response.ok) return { available: false, detail: `HTTP ${response.status} from /models` };
      return { available: true, detail: "OpenAI-compatible endpoint reachable" };
    } catch (error) {
      return { available: false, detail: `probe failed: ${error.message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  async run({ model, prompt, timeoutMs = 10 * 60 * 1000 }) {
    const resolved = this.resolve(model);
    if (!resolved.baseURL) throw new Error(`Provider ${this.name}: baseURL is not configured`);
    if (resolved.requiresKey && !resolved.apiKey) {
      throw new Error(`Provider ${this.name}: missing API key env ${resolved.apiKeyEnv ?? "(none configured)"}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const response = await fetch(joinUrl(resolved.baseURL, "/chat/completions"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {}),
          ...(this.config.headers ?? {})
        },
        body: JSON.stringify({
          model: resolved.remoteModel,
          messages: [{ role: "user", content: prompt }],
          temperature: Number(this.config.temperature ?? 0.2),
          max_tokens: Number(this.config.maxTokens ?? 4096),
          stream: false
        }),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${tail(text, 1200)}`);
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Provider returned non-JSON response: ${tail(text, 800)}`);
      }
      const content = data?.choices?.[0]?.message?.content;
      const output = Array.isArray(content)
        ? content.map((part) => part.text ?? "").join("")
        : String(content ?? "");
      if (!output.trim()) throw new Error("Provider returned an empty message");
      const tokensIn = Number(data?.usage?.prompt_tokens ?? Math.ceil(prompt.length / 3));
      const tokensOut = Number(data?.usage?.completion_tokens ?? Math.ceil(output.length / 3));
      const costCny = estimateCostCny(model, { input: tokensIn, output: tokensOut });
      return {
        output,
        artifacts: parseArtifactBlocks(output),
        tokensIn,
        tokensOut,
        costCny,
        latencyMs: Date.now() - started,
        meta: {
          provider: this.name,
          modelId: model.id,
          remoteModel: resolved.remoteModel,
          simulated: false,
          evidenceClass: "real",
          responseId: data?.id ?? null,
          finishReason: data?.choices?.[0]?.finish_reason ?? null,
          receivedAt: nowIso()
        }
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async discover({ settings = {} } = {}) {
    const resolved = this.resolve({ id: this.name, raw: {}, baseURL: null, apiKeyEnv: null });
    if (!resolved.baseURL) throw new Error("baseURL is not configured");
    const response = await fetch(joinUrl(resolved.baseURL, "/models"), {
      headers: resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {}
    });
    if (!response.ok) throw new Error(`Discovery failed: HTTP ${response.status}`);
    const data = await response.json();
    const usdToCny = Number(settings.usdToCny ?? 7.2);
    const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    return rows.map((row) => {
      const promptPrice = Number(row?.pricing?.prompt ?? 0);
      const completionPrice = Number(row?.pricing?.completion ?? 0);
      const free = promptPrice === 0 && completionPrice === 0;
      const id = row.id;
      return normalizeModel({
        id: `${this.name}/${id}`,
        provider: this.name,
        remoteModel: id,
        label: row.name || id,
        costClass: free ? "free" : "unknown",
        privacy: "public",
        available: true,
        contextTokens: Number(row?.context_length ?? row?.top_provider?.context_length ?? 128000),
        inputCostCnyPerMTok: promptPrice * 1_000_000 * usdToCny,
        outputCostCnyPerMTok: completionPrice * 1_000_000 * usdToCny,
        latencyMs: 800,
        capabilities: {
          reasoning: 50,
          coding: 50,
          research: 50,
          writing: 50,
          design: 50,
          review: 50,
          tools: 50,
          multimodal: 0,
          speed: 50
        },
        notes: "Discovered dynamically. Cost and privacy are conservative defaults; capability scores must be calibrated before quality-sensitive use.",
        tags: ["discovered", free ? "free" : "priced"]
      }, "discovered");
    });
  }
}
