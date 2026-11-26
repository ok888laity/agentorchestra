import { resolveProviderForModel } from "../config.js";
import { CliProvider } from "./cli.js";
import { HostHttpProvider } from "./host-http.js";
import { MockProvider } from "./mock.js";
import { OpenAiCompatibleProvider } from "./openai.js";

export class ProviderHub {
  constructor({ config, models }) {
    this.config = config;
    this.models = models;
    this.instances = new Map();
  }

  create(providerName) {
    const providerConfig = this.config.providers?.[providerName];
    if (!providerConfig) throw new Error(`Provider "${providerName}" is not configured`);
    if (providerConfig.type === "mock") return new MockProvider({ name: providerName });
    if (providerConfig.type === "cli") return new CliProvider({ name: providerName, config: providerConfig });
    if (providerConfig.type === "openai") {
      return new OpenAiCompatibleProvider({ name: providerName, config: providerConfig, settings: this.config.settings });
    }
    if (providerConfig.type === "host-http") {
      return new HostHttpProvider({ name: providerName, config: providerConfig });
    }
    throw new Error(`Unknown provider type "${providerConfig.type}" for ${providerName}`);
  }

  get(providerName) {
    if (!this.instances.has(providerName)) this.instances.set(providerName, this.create(providerName));
    return this.instances.get(providerName);
  }

  forModel(model) {
    const providerConfig = resolveProviderForModel(model, this.config.providers);
    if (!providerConfig) throw new Error(`No provider config for model ${model.id} (provider ${model.provider})`);
    return this.get(model.provider);
  }

  async run({ model, prompt, cwd, task, role = "execute", attempt = 1, context = {}, timeoutMs }) {
    const provider = this.forModel(model);
    return provider.run({
      model,
      prompt,
      cwd,
      root: this.config.root,
      task,
      role,
      attempt,
      context,
      timeoutMs
    });
  }

  async probeAll() {
    const providers = new Set([
      ...this.models.map((model) => model.provider),
      ...Object.keys(this.config.providers ?? {})
    ]);
    const results = {};
    await Promise.all([...providers].map(async (providerName) => {
      try {
        const provider = this.get(providerName);
        results[providerName] = await provider.probe();
      } catch (error) {
        results[providerName] = { available: false, detail: error.message };
      }
    }));
    return results;
  }

  async discover(providerName) {
    const provider = this.get(providerName);
    if (typeof provider.discover !== "function") throw new Error(`Provider ${providerName} does not support discovery`);
    return provider.discover({ settings: this.config.settings });
  }
}
