import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const plugin = path.join(root, "plugin");
const checks = [];

function check(name, fn) {
  try {
    fn();
    checks.push({ ok: true, name });
  } catch (error) {
    checks.push({ ok: false, name, detail: error.message });
  }
}

function json(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

check("plugin bundle exists", () => assert.ok(fs.existsSync(plugin)));
check("Codex portable manifest", () => {
  const manifest = json(path.join(plugin, "plugin.json"));
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(manifest.name, "agentorchestra");
  assert.ok(manifest.version);
  assert.ok(manifest.extensions?.["com.openai"]?.interface);
});
check("Codex compatibility manifest", () => {
  const manifest = json(path.join(plugin, ".codex-plugin", "plugin.json"));
  assert.equal(manifest.name, "agentorchestra");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
});
check("portable stdio MCP config", () => {
  const doc = json(path.join(plugin, "mcp.json"));
  assert.equal(doc.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  const server = doc.mcpServers.agentorchestra;
  assert.equal(server.type, "stdio");
  assert.equal(server.command, "node");
  assert.ok(server.args.includes("./server/launch-mcp.js"));
  assert.ok(server.cwd.startsWith("./"));
});
check("OpenCode plugin package", () => {
  const pkg = json(path.join(plugin, "package.json"));
  assert.equal(pkg.name, "agentorchestra-opencode-plugin");
  assert.equal(pkg.exports["."], "./opencode-server.js");
  const source = fs.readFileSync(path.join(plugin, "opencode-server.js"), "utf8");
  assert.match(source, /Plugin\.define/);
  assert.match(source, /ctx\.mcp\.transform/);
  assert.match(source, /ctx\.skill\.transform/);
  assert.match(source, /ctx\.session\.hook\("prompt"/);
  assert.match(source, /syncHostModels/);
  assert.match(source, /syncHostProviders/);
  assert.match(source, /startHostBridge/);
  assert.match(source, /host-opencode/);
  assert.match(source, /orchestra-models/);
  assert.match(source, /@opencode\/plugin/);
});
check("bundled skill", () => {
  const file = path.join(plugin, "skills", "agentorchestra", "SKILL.md");
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /^---[\s\S]*?name:\s*AgentOrchestra/);
  assert.match(text, /node server\/cli-plugin\.js/);
  assert.match(text, /server\/launch-mcp\.js/);
});
check("bundled core", () => {
  for (const file of ["server/mcp.js", "server/cli-plugin.js", "server/launch-mcp.js", "server/scheduler.js", "server/pool.js", "server/host-models.js", "server/classify.js", "server/sync-codex-host.js", "server/providers/host-http.js", "hooks/hooks.json", "scripts/install.js", "config/models.json", "config/providers.json", "config/host-policy.json", "examples/starter.json"]) {
    assert.ok(fs.existsSync(path.join(plugin, file)), `missing ${file}`);
  }
  const mcp = fs.readFileSync(path.join(plugin, "server", "mcp.js"), "utf8");
  assert.match(mcp, /orchestra_plan_pool/);
  assert.match(mcp, /orchestra_sync_models/);
  assert.match(mcp, /orchestra_confirm_host_models/);
  assert.match(mcp, /orchestra_classify_host_models/);
  assert.match(mcp, /orchestra_set_provider_policy/);
});

check("shipped provider defaults are neutral", () => {
  const policy = json(path.join(plugin, "config", "host-policy.json"));
  for (const rule of Object.values(policy.providers ?? {})) {
    assert.equal(rule.enabled, false, "plugin defaults must not enable any host provider before user confirmation");
  }
});

check("plugin bundle is fresh", () => {
  const pairs = [
    ["src/scheduler.js", "server/scheduler.js"],
    ["src/router.js", "server/router.js"],
    ["src/pool.js", "server/pool.js"],
    ["src/host-models.js", "server/host-models.js"],
    ["src/classify.js", "server/classify.js"],
    ["scripts/install.js", "scripts/install.js"],
    ["src/mcp.js", "server/mcp.js"],
    ["src/cli.js", "server/cli.js"],
    ["src/providers/host-http.js", "server/providers/host-http.js"],
    ["src/providers/index.js", "server/providers/index.js"],
    ["config/policy.json", "config/policy.json"],
    ["config/providers.json", "config/providers.json"],
    ["config/host-policy.json", "config/host-policy.json"]
  ];
  for (const [source, bundle] of pairs) {
    const left = fs.readFileSync(path.join(root, source), "utf8");
    const right = fs.readFileSync(path.join(plugin, bundle), "utf8");
    assert.equal(left, right, `${bundle} is stale; run npm run build:plugin`);
  }
});

async function verifyBundledMcp() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentorchestra-plugin-"));
  try {
    const child = spawn(process.execPath, ["server/launch-mcp.js"], {
      cwd: plugin,
      env: { ...process.env, AGENTORCHESTRA_ROOT: stateDir, PLUGIN_DATA: stateDir },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify-plugin" } }
    })}\n`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`bundled MCP timeout. stdout=${stdout} stderr=${stderr}`)), 8000);
      const poll = () => {
        if (stdout.includes("\n")) {
          clearTimeout(timer);
          resolve();
        } else {
          setTimeout(poll, 50);
        }
      };
      poll();
    });
    const response = JSON.parse(stdout.split(/\r?\n/).find(Boolean));
    assert.equal(response.result.serverInfo.name, "agentorchestra");
    assert.ok(response.result.capabilities.tools);
    child.stdin.end();
    await new Promise((resolve) => child.once("close", resolve));
    checks.push({ ok: true, name: "bundled MCP stdio handshake" });
  } catch (error) {
    checks.push({ ok: false, name: "bundled MCP stdio handshake", detail: error.message });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

await verifyBundledMcp();
for (const item of checks) {
  process.stdout.write(`${item.ok ? "[ok]" : "[!!]"} ${item.name}${item.detail ? `: ${item.detail}` : ""}\n`);
}
const failed = checks.filter((item) => !item.ok);
if (failed.length) process.exitCode = 1;
