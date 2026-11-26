import { estimateCostCny } from "../registry.js";
import { nowIso, tail } from "../util.js";

function parseArtifactBlocks(output) {
  const artifacts = [];
  const pattern = /```(?:artifact|file)\s+(?:path=)?([^\s`]+)\s*\n([\s\S]*?)```/gi;
  for (const match of String(output ?? "").matchAll(pattern)) {
    artifacts.push({ path: match[1].trim(), content: match[2] });
  }
  return artifacts;
}

function parseModelRef(remoteModel) {
  const value = String(remoteModel ?? "");
  const split = value.indexOf("/");
  if (split < 0) return { providerID: "unknown", modelID: value };
  return {
    providerID: value.slice(0, split),
    modelID: value.slice(split + 1)
  };
}

export class HostHttpProvider {
  constructor({ name, config = {} }) {
    this.name = name;
    this.config = config;
  }

  resolve() {
    const endpoint = (this.config.endpointEnv && process.env[this.config.endpointEnv]) || this.config.endpoint || "";
    const token = (this.config.tokenEnv && process.env[this.config.tokenEnv]) || this.config.token || "";
    return {
      endpoint: String(endpoint).replace(/\/+$/, ""),
      token,
      timeoutMs: Math.max(60_000, Number(this.config.timeoutMinutes ?? 10) * 60_000)
    };
  }

  async probe() {
    const { endpoint, token, timeoutMs } = this.resolve();
    if (!endpoint) return { available: false, detail: "host bridge endpoint is not configured" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 5000));
    try {
      const response = await fetch(`${endpoint}/health`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal
      });
      if (!response.ok) return { available: false, detail: `host bridge HTTP ${response.status}` };
      return { available: true, detail: "OpenCode host bridge reachable" };
    } catch (error) {
      return { available: false, detail: `host bridge probe failed: ${error.message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  async run({ model, prompt, task, timeoutMs = null }) {
    const { endpoint, token, timeoutMs: configTimeout } = this.resolve();
    if (!endpoint) throw new Error("Host bridge endpoint is not configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(timeoutMs ?? configTimeout));
    const ref = parseModelRef(model.remoteModel || model.id);
    const started = Date.now();
    try {
      const response = await fetch(`${endpoint}/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          model: ref,
          prompt,
          taskId: task?.id ?? null
        }),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Host bridge HTTP ${response.status}: ${tail(text, 1200)}`);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Host bridge returned non-JSON: ${tail(text, 800)}`);
      }
      const output = String(data.text ?? data.output ?? "");
      if (!output.trim()) throw new Error("Host bridge returned empty text");
      const tokensIn = Number(data.usage?.input ?? data.tokensIn ?? Math.ceil(prompt.length / 3));
      const tokensOut = Number(data.usage?.output ?? data.tokensOut ?? Math.ceil(output.length / 3));
      return {
        output,
        artifacts: parseArtifactBlocks(output),
        tokensIn,
        tokensOut,
        costCny: Number(data.usage?.costCny ?? estimateCostCny(model, { input: tokensIn, output: tokensOut })),
        latencyMs: Date.now() - started,
        meta: {
          provider: this.name,
          modelId: model.id,
          remoteModel: model.remoteModel || model.id,
          simulated: false,
          evidenceClass: "real",
          host: true,
          receivedAt: nowIso()
        }
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
