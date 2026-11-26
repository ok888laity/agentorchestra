import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { classifyHostModels, classificationSummaryText, writeProviderPolicy } from "../src/classify.js";
import { syncHostModels } from "../src/host-models.js";
import { readJson } from "../src/util.js";
import { cleanup, makeTempProject } from "./helpers.js";

test("provider classification uses prices, endpoints and auth mode with confidence", (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  syncHostModels(dir, {
    source: "opencode",
    billing: "unknown",
    privacy: "unknown",
    executor: "host-opencode",
    models: [
      { providerID: "opencode-go", id: "hungerg-free", remoteModel: "opencode-go/hungerg-free", label: "HungerG Free", costHint: "zero" },
      { providerID: "opencode-go", id: "qwen4-max", remoteModel: "opencode-go/qwen4-max", label: "Qwen4 Max", costHint: "nonzero", cost: { input: 2, output: 10 } },
      { providerID: "openai", id: "gpt-paid", remoteModel: "openai/gpt-paid", label: "GPT Paid", costHint: "nonzero", cost: { input: 3, output: 15 } },
      { providerID: "ollama", id: "qwen-local", remoteModel: "ollama/qwen-local", label: "Qwen Local", costHint: "zero" },
      { providerID: "codex", id: "gpt-smoke", remoteModel: "codex/gpt-smoke", label: "Codex GPT" }
    ]
  });
  const metaDir = path.join(dir, ".orchestra");
  fs.writeFileSync(path.join(metaDir, "host-providers.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    providers: {
      "opencode-go": { id: "opencode-go", baseURLHost: "api.example.com" },
      "openai": { id: "openai", baseURLHost: "api.openai.com" },
      "ollama": { id: "ollama", baseURLHost: "127.0.0.1" },
      "codex": { id: "codex", baseURLHost: "codex.local" }
    }
  }, "utf8"));

  const report = classifyHostModels(dir, { codexAuth: { mode: "chatgpt", hasApiKey: false, hasOAuthTokens: true } });
  const groups = Object.fromEntries(report.groups.map((group) => [group.provider, group]));
  assert.equal(groups.ollama.billing.suggested, "local");
  assert.equal(groups.ollama.privacy.suggested, "local");
  assert.equal(groups.ollama.privacy.requiresConfirmation, false);
  assert.equal(groups.openai.billing.suggested, "api");
  assert.equal(groups.openai.privacy.trustedCandidate, true);
  assert.equal(groups.openai.privacy.requiresConfirmation, true);
  assert.equal(groups.codex.billing.suggested, "subscription");
  assert.equal(groups.codex.billing.confidence, "high");
  assert.ok(["free", "subscription"].includes(groups["opencode-go"].billing.suggested));
  assert.ok(report.choicesRequired.some((choice) => choice.provider === "openai"));
  assert.match(classificationSummaryText(report), /Needs choice/);
});

test("user choice is persisted into host policy", (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const updated = writeProviderPolicy(dir, "openai", { billing: "api", privacy: "trusted", enabled: true });
  assert.equal(updated.privacy, "trusted");
  const doc = readJson(path.join(dir, ".orchestra", "host-policy.json"));
  assert.equal(doc.providers.openai.privacy, "trusted");
  assert.equal(doc.providers.openai.userChoice, true);
  const shipped = readJson(path.join(dir, "config", "host-policy.json"));
  assert.equal(shipped.providers.openai.enabled, false, "shipped defaults must stay neutral");
  assert.equal(shipped.providers.opencode.enabled, false, "shipped defaults must stay neutral");
});
