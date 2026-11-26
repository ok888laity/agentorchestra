import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOL_ROOT, loadConfig } from "../src/config.js";
import { ProviderHub } from "../src/providers/index.js";
import { Scheduler } from "../src/scheduler.js";
import { Store } from "../src/store.js";

export function makeTempProject(prefix = "agentorchestra-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(path.join(TOOL_ROOT, "config"), path.join(dir, "config"), { recursive: true });
  fs.cpSync(path.join(TOOL_ROOT, "examples"), path.join(dir, "examples"), { recursive: true });
  fs.cpSync(path.join(TOOL_ROOT, "scripts"), path.join(dir, "scripts"), { recursive: true });
  return dir;
}

export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function makeRuntime(dir, { project = "test" } = {}) {
  const config = loadConfig(dir);
  const store = new Store(dir, { project, policy: config.policyDefaults });
  const providers = new ProviderHub({ config, models: config.models });
  const scheduler = new Scheduler({ root: dir, store, config, providers });
  return { dir, config, store, providers, scheduler };
}
