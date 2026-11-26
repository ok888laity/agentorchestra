import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncHostModels } from "./host-models.js";

const home = os.homedir();
let auth = {};
let catalogue = { models: [] };
try {
  auth = JSON.parse(fs.readFileSync(path.join(home, ".codex", "auth.json"), "utf8"));
} catch {
  auth = {};
}
try {
  catalogue = JSON.parse(fs.readFileSync(path.join(home, ".codex", "models_cache.json"), "utf8"));
} catch {
  catalogue = { models: [] };
}
const mode = String(auth.auth_mode ?? "unknown");
const billing = mode === "chatgpt" ? "subscription" : mode === "apikey" ? "api" : "unknown";
const models = (catalogue.models ?? [])
  .map((model) => ({
    providerID: "codex",
    id: String(model.id ?? model.slug ?? ""),
    remoteModel: String(model.id ?? model.slug ?? ""),
    name: String(model.display_name ?? model.name ?? model.id ?? ""),
    available: true
  }))
  .filter((model) => model.id);
const root = process.env.AGENTORCHESTRA_ROOT || process.env.PLUGIN_DATA || path.join(home, ".agentorchestra");
const result = syncHostModels(root, {
  models,
  source: "codex",
  billing,
  privacy: "unknown",
  executor: "codex"
});
console.error("[agentorchestra] synced " + result.count + " Codex host models (auth=" + mode + ") -> " + result.file);

