import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ensureCodexProjectConfig, installSummary, parseArgs, upsertOpencodePlugin } from "../scripts/install.js";
import { readJson } from "../src/util.js";
import { cleanup, makeTempProject } from "./helpers.js";

test("install flags parse", () => {
  const flags = parseArgs(["--host", "codex", "--global", "--dry-run", "--json"]);
  assert.equal(flags.host, "codex");
  assert.equal(flags.global, true);
  assert.equal(flags.dryRun, true);
  assert.equal(flags.json, true);
});

test("opencode plugin entry is added once and preserves options", (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const configFile = path.join(dir, "opencode.json");
  fs.writeFileSync(configFile, JSON.stringify({ $schema: "https://opencode.ai/config.json", plugins: ["other-plugin"] }, null, 2));
  const plugin = path.join(dir, "plugin");
  const first = upsertOpencodePlugin(configFile, plugin, path.join(dir, "AgentOrchestra"));
  assert.equal(first.action, "added");
  const second = upsertOpencodePlugin(configFile, plugin, path.join(dir, "AgentOrchestra"));
  assert.equal(second.action, "already-present");
  const doc = readJson(configFile);
  assert.equal(doc.plugins.length, 2);
  const entry = doc.plugins.find((item) => typeof item === "object");
  assert.ok(entry.options.root);
});

test("codex project config is enabled idempotently", (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const file = path.join(dir, ".codex", "config.toml");
  assert.equal(ensureCodexProjectConfig(file).action, "enabled");
  assert.equal(ensureCodexProjectConfig(file).action, "already-enabled");
  assert.match(fs.readFileSync(file, "utf8"), /agentorchestra@agentorchestra-local/);
});

test("install summary names both hosts and next step", () => {
  const text = installSummary({ ok: true, hosts: { opencode: true, codex: true }, steps: [], warnings: [], manual: [] });
  assert.match(text, /opencode, codex/);
  assert.match(text, /\/orchestra-models/);
});
