#!/usr/bin/env node
// Universal, idempotent installer for AgentOrchestra.
// Detects OpenCode and/or Codex, registers the plugin, and makes it available
// in every conversation of the project (and optionally every project).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const repoRoot = path.resolve(projectRoot, "..");
const pluginDir = path.join(projectRoot, "plugin");
const stateRoot = projectRoot;

export function parseArgs(argv = []) {
  const flags = { global: false, host: "auto", json: false, dryRun: false, skipOpencode: false, skipCodex: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--global") flags.global = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--host") flags.host = argv[++i] ?? "auto";
    else if (arg === "--skip-opencode") flags.skipOpencode = true;
    else if (arg === "--skip-codex") flags.skipCodex = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
  }
  return flags;
}

export function commandExists(name) {
  const probe = spawnSync(name, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  return !probe.error && probe.status === 0;
}

export function detectHosts(flags = {}) {
  const opencode = !flags.skipOpencode && (
    flags.host === "opencode" || flags.host === "auto" && (
      commandExists("opencode") || fs.existsSync(path.join(repoRoot, "opencode.json"))
    )
  );
  const codex = !flags.skipCodex && (
    flags.host === "codex" || flags.host === "auto" && (
      commandExists("codex") || fs.existsSync(path.join(repoRoot, ".codex"))
    )
  );
  return { opencode: Boolean(opencode), codex: Boolean(codex) };
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function upsertOpencodePlugin(configPath, pluginPath, statePath) {
  const doc = readJsonFile(configPath, { $schema: "https://opencode.ai/config.json", plugins: [] });
  doc.plugins = Array.isArray(doc.plugins) ? doc.plugins : [];
  const configDir = path.dirname(configPath);
  const resolveEntry = (value) => path.resolve(configDir, value);
  const match = doc.plugins.find((entry) => {
    if (typeof entry === "string") return resolveEntry(entry) === path.resolve(pluginPath);
    return entry && typeof entry === "object" && entry.package && resolveEntry(entry.package) === path.resolve(pluginPath);
  });
  if (match) {
    const existingPackage = typeof match === "string" ? match : match.package;
    const existingRoot = typeof match === "object" ? match.options?.root : undefined;
    const packageOk = existingPackage && resolveEntry(existingPackage) === path.resolve(pluginPath);
    const rootOk = existingRoot && resolveEntry(existingRoot) === path.resolve(statePath);
    if (packageOk && rootOk) return { file: configPath, action: "already-present", entry: match };
  }
  const entry = {
    package: path.relative(configDir, pluginPath).replace(/\\/g, "/") || pluginPath,
    options: { root: path.relative(configDir, statePath).replace(/\\/g, "/") || statePath }
  };
  if (typeof match === "object" && match?.options) entry.options = { ...match.options, ...entry.options };
  if (!match) doc.plugins.push(entry);
  else doc.plugins[doc.plugins.indexOf(match)] = entry;
  writeJsonFile(configPath, doc);
  return { file: configPath, action: match ? "updated" : "added", entry };
}

export function ensureCodexProjectConfig(file = path.join(repoRoot, ".codex", "config.toml")) {
  const line = '[plugins."agentorchestra@agentorchestra-local"]\nenabled = true\n';
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (current.includes('agentorchestra@agentorchestra-local')) return { file, action: "already-enabled" };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${current.trimEnd()}\n\n${line}`, "utf8");
  return { file, action: "enabled" };
}

function runCli(name, args) {
  const result = spawnSync(name, args, { encoding: "utf8", windowsHide: true, timeout: 120000 });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: !result.error && result.status === 0, status: result.status, text };
}

export function install(args = []) {
  const flags = parseArgs(args);
  const report = { hosts: detectHosts(flags), steps: [], warnings: [], manual: [], ok: true };

  if (flags.help) {
    report.manual.push("Usage: node scripts/install.js [--host auto|opencode|codex] [--global] [--dry-run] [--json]");
    return report;
  }
  if (!fs.existsSync(path.join(pluginDir, "opencode-server.js"))) {
    report.ok = false;
    report.warnings.push("Plugin bundle missing. Run: node scripts/build-plugin.js");
    return report;
  }

  if (report.hosts.opencode) {
    const targets = [
      { file: path.join(repoRoot, "opencode.json"), plugin: pluginDir, state: stateRoot },
      ...(flags.global ? [{ file: path.join(os.homedir(), ".config", "opencode", "opencode.json"), plugin: pluginDir, state: stateRoot }] : [])
    ];
    for (const target of targets) {
      if (flags.dryRun) {
        report.steps.push({ host: "opencode", action: "dry-run", file: target.file });
        continue;
      }
      report.steps.push({ host: "opencode", ...upsertOpencodePlugin(target.file, target.plugin, target.state) });
    }
  }

  if (report.hosts.codex) {
    if (!flags.dryRun) report.steps.push({ host: "codex", ...ensureCodexProjectConfig() });
    if (commandExists("codex")) {
      if (flags.dryRun) {
        report.steps.push({ host: "codex", action: "dry-run", commands: ["codex plugin marketplace add .", "codex plugin add agentorchestra@agentorchestra-local"] });
      } else {
        const market = runCli("codex", ["plugin", "marketplace", "add", repoRoot, "--json"]);
        report.steps.push({ host: "codex", action: "marketplace", ok: market.ok, detail: market.text.slice(0, 300) });
        if (!market.ok) report.warnings.push("Marketplace add failed; see step detail.");
        const add = runCli("codex", ["plugin", "add", "agentorchestra@agentorchestra-local", "--json"]);
        report.steps.push({ host: "codex", action: "plugin-add", ok: add.ok, detail: add.text.slice(0, 300) });
        if (!add.ok) report.warnings.push("Plugin install failed; run manually: codex plugin add agentorchestra@agentorchestra-local");
      }
    } else {
      report.manual.push("Codex CLI not on PATH. After installing it, run:");
      report.manual.push("  codex plugin marketplace add .");
      report.manual.push("  codex plugin add agentorchestra@agentorchestra-local");
    }
  }

  if (!report.hosts.opencode && !report.hosts.codex) {
    report.ok = false;
    report.warnings.push("No supported host detected. Use --host opencode or --host codex.");
  }
  return report;
}

export function installSummary(report, flags = {}) {
  const lines = [
    `AgentOrchestra installer: ${report.ok ? "OK" : "incomplete"}`,
    `Detected hosts: ${Object.entries(report.hosts).filter(([, on]) => on).map(([name]) => name).join(", ") || "none"}`
  ];
  for (const step of report.steps) {
    lines.push(`- ${step.host}/${step.action}${step.file ? ` -> ${step.file}` : ""}${step.ok === false ? " (FAILED)" : ""}`);
  }
  for (const warning of report.warnings) lines.push(`WARNING: ${warning}`);
  for (const manual of report.manual) lines.push(manual);
  lines.push("Then start a new conversation. In OpenCode: /orchestra-models. In Codex: the skill and MCP tools load automatically.");
  if (flags.global) lines.push("--global writes the OpenCode user config; Codex installs are always user-wide.");
  return lines.join("\n");
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const flags = parseArgs(process.argv.slice(2));
  const report = install(process.argv.slice(2));
  if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${installSummary(report, flags)}\n`);
  if (!report.ok) process.exitCode = 1;
}
