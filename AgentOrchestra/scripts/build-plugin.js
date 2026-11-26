import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const target = path.join(root, "plugin");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

function copyDir(source, destination, filter) {
  fs.cpSync(source, destination, { recursive: true, ...(filter ? { filter } : {}) });
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`, "utf8");
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });

copyDir(path.join(root, "src"), path.join(target, "server"), (src) => !/dashboard\.(js|html)$/.test(src));
copyDir(path.join(root, "config"), path.join(target, "config"));
copyDir(path.join(root, "examples"), path.join(target, "examples"));
copyDir(path.join(root, "docs"), path.join(target, "docs"));
fs.mkdirSync(path.join(target, "scripts"), { recursive: true });
fs.copyFileSync(path.join(root, "scripts", "demo-check.js"), path.join(target, "scripts", "demo-check.js"));
fs.copyFileSync(path.join(root, "scripts", "install.js"), path.join(target, "scripts", "install.js"));
fs.copyFileSync(path.join(root, "gui-src", "rpc.js"), path.join(target, "server", "rpc.js"));
fs.copyFileSync(path.join(root, "src", "update.js"), path.join(target, "server", "update.js"));
fs.copyFileSync(path.join(root, "LICENSE"), path.join(target, "LICENSE"));

let skill = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
skill = skill
  .replaceAll("node src/cli.js", "node server/cli-plugin.js")
  .replaceAll("node src/mcp.js", "node server/launch-mcp.js")
  .replace("Run from the `AgentOrchestra/` directory:", "Use the bundled MCP tools by default. If you need the CLI, run from the plugin root:")
  .replace(
    "The server is stdio-only: `node server/launch-mcp.js` from `AgentOrchestra/`. OpenCode configuration is in the workspace `opencode.json`; the project skill is discovered from `.opencode/skills/agentorchestra/`.",
    "The plugin bundles the stdio server at `server/launch-mcp.js`. Codex loads it through `mcp.json` / `.mcp.json`; OpenCode registers it through `opencode-server.js`."
  );
skill += `

## Plugin mode

This is the installable plugin bundle. The MCP server is bundled at \`server/launch-mcp.js\`; Codex uses the root \`mcp.json\` / compatibility \`.mcp.json\`, and OpenCode registers it automatically through \`opencode-server.js\`.

- Codex state defaults to \`PLUGIN_DATA\` or \`~/.agentorchestra\`; configuration falls back to the bundled \`config/\`.
- OpenCode state is project-scoped by default, or set \`options.root\` in the plugin entry.
- CLI fallback: \`node server/cli-plugin.js status\`.
- Do not edit files under the installed plugin cache for persistent policy; use the MCP tools or a project-local root.
`;
write(path.join(target, "skills", "agentorchestra", "SKILL.md"), skill);

write(path.join(target, "server", "launch-mcp.js"), `import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMcpServer } from "./mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const dataRoot = process.env.AGENTORCHESTRA_ROOT
  || process.env.PLUGIN_DATA
  || path.join(os.homedir(), ".agentorchestra");
process.env.AGENTORCHESTRA_ROOT = dataRoot;

// The starter demo references {root}/scripts/demo-check.js. Keep the
// deterministic fixture available in the writable data root.
const fixture = path.join(pluginRoot, "scripts", "demo-check.js");
if (fs.existsSync(fixture)) {
  fs.mkdirSync(path.join(dataRoot, "scripts"), { recursive: true });
  fs.copyFileSync(fixture, path.join(dataRoot, "scripts", "demo-check.js"));
}

startMcpServer({ root: dataRoot }).catch((error) => {
  process.stderr.write(\`[agentorchestra] plugin MCP failed: \${error.message}\\n\`);
  process.exit(1);
});
`);

write(path.join(target, "server", "cli-plugin.js"), `import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
process.env.AGENTORCHESTRA_ROOT ||= process.env.PLUGIN_DATA || path.join(os.homedir(), ".agentorchestra");
const fixture = path.join(pluginRoot, "scripts", "demo-check.js");
if (fs.existsSync(fixture)) {
  fs.mkdirSync(path.join(process.env.AGENTORCHESTRA_ROOT, "scripts"), { recursive: true });
  fs.copyFileSync(fixture, path.join(process.env.AGENTORCHESTRA_ROOT, "scripts", "demo-check.js"));
}
await import("./cli.js");
`);

const interfaceBlock = {
  displayName: "AgentOrchestra",
  shortDescription: "Cost-aware, verification-driven multi-model orchestration",
  longDescription: "DAG-based multi-model orchestration with free/paid routing, budgets, privacy boundaries, independent review, human gates, resource locks, versioned artifacts and resumable state. Mock output is explicitly simulated and is not engineering evidence.",
  developerName: "AgentOrchestra contributors",
  category: "Developer Tools",
  capabilities: ["Read", "Write"],
  defaultPrompt: [
    "Plan this engineering task with AgentOrchestra, then run the ready nodes.",
    "Check AgentOrchestra acceptance progress, budget and blockers.",
    "Use AgentOrchestra to split this task across specialist models without losing the acceptance bar."
  ],
  brandColor: "#5DE4D3"
};

write(path.join(target, "plugin.json"), {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: "agentorchestra",
  version,
  description: "Cost-aware, verification-driven multi-model orchestration with DAGs, budgets, privacy gates, human gates and resumable state.",
  author: { name: "AgentOrchestra contributors" },
  license: "MIT",
  keywords: ["multi-agent", "orchestration", "model-routing", "budget", "mcp", "dag", "codex", "opencode"],
  extensions: {
    "com.openai": {
      onboardingSkill: "./skills/agentorchestra/SKILL.md",
      hooks: "./hooks/hooks.json",
      interface: interfaceBlock
    }
  }
});

write(path.join(target, ".codex-plugin", "plugin.json"), {
  name: "agentorchestra",
  version,
  description: "Cost-aware, verification-driven multi-model orchestration with DAGs, budgets, privacy gates, human gates and resumable state.",
  author: { name: "AgentOrchestra contributors" },
  license: "MIT",
  keywords: ["multi-agent", "orchestration", "model-routing", "budget", "mcp", "dag", "codex", "opencode"],
  skills: "./skills/",
  mcpServers: "./.mcp.json",
  hooks: "./hooks/hooks.json",
  interface: interfaceBlock
});

write(path.join(target, "server", "sync-codex-host.js"), `import fs from "node:fs";
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
`);

write(path.join(target, "hooks", "hooks.json"), {
  hooks: {
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            command: "node ${PLUGIN_ROOT}/server/sync-codex-host.js",
            statusMessage: "Syncing AgentOrchestra Codex host models"
          }
        ]
      }
    ]
  }
});

write(path.join(target, "mcp.json"), {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {
    agentorchestra: {
      type: "stdio",
      command: "node",
      args: ["./server/launch-mcp.js"],
      cwd: "./"
    }
  }
});

write(path.join(target, ".mcp.json"), {
  mcpServers: {
    agentorchestra: {
      command: "node",
      args: ["./server/launch-mcp.js"],
      cwd: "."
    }
  }
});

write(path.join(target, "opencode-server.js"), `import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin, Skill } from "@opencode/plugin";
import { Rpc } from "@opencode/plugin/rpc";
import { classifyHostModels, classificationSummaryText, writeProviderPolicy } from "./server/classify.js";
import { loadConfig } from "./server/config.js";
import { planFromObject } from "./server/domain.js";
import { syncHostModels } from "./server/host-models.js";
import { planPool, poolSummaryText } from "./server/pool.js";
import { ProviderHub } from "./server/providers/index.js";
import { Orchestra } from "./server/rpc.js";
import { routeTask, routePreviewText } from "./server/router.js";
import { Scheduler } from "./server/scheduler.js";
import { Store } from "./server/store.js";
import { checkForUpdate, runUpdate, updateSummaryText } from "./server/update.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, "server", "launch-mcp.js");
const skillFile = path.join(here, "skills", "agentorchestra", "SKILL.md");
const skillContent = fs.readFileSync(skillFile, "utf8").replace(/^---[\\s\\S]*?---\\s*/, "");
const description = "Cost-aware, verification-driven multi-model orchestration for long, multi-module work. Use for DAG decomposition, budget/privacy-aware routing, independent review, human gates, resource locks, or resumable execution.";

function makeSkillDefinition() {
  return {
    id: Skill.ID.make("agentorchestra"),
    name: Skill.Name.make("AgentOrchestra"),
    description,
    path: Skill.Info.fields.path.make(skillFile),
    content: skillContent
  };
}

async function refreshHostModels(ctx, stateRoot, executor = "opencode") {
  const listed = await ctx.model.list();
  const models = Array.isArray(listed) ? listed : listed?.data ?? [];
  return syncHostModels(stateRoot, {
    models: models.map((model) => ({
      providerID: model.providerID,
      id: model.id,
      name: model.name,
      remoteModel: model.providerID + "/" + model.id,
      contextTokens: model.limit?.context,
      capabilities: model.capabilities,
      cost: model.cost,
      available: model.enabled !== false
    })),
    source: "opencode",
    billing: ctx.options?.hostBilling ?? "unknown",
    privacy: ctx.options?.hostPrivacy ?? "unknown",
    executor
  });
}

async function syncHostProviders(ctx, stateRoot) {
  const listed = await ctx.provider.list();
  const records = Array.isArray(listed) ? listed : listed?.data ?? [];
  const providers = {};
  for (const record of records) {
    const info = record.provider ?? record.info ?? {};
    const id = String(info.id ?? record.id ?? "unknown");
    const settings = info.settings ?? {};
    const rawBase = settings.baseURL ?? settings.baseUrl ?? "";
    let baseURLHost = null;
    try {
      if (rawBase) baseURLHost = new URL(rawBase).hostname;
    } catch {
      baseURLHost = null;
    }
    providers[id] = {
      id,
      name: info.name ?? id,
      package: info.package ?? null,
      activation: info.activation ?? null,
      baseURLHost,
      hasSourceConnection: Boolean(record.sourceConnection)
    };
  }
  const dir = path.join(stateRoot, ".orchestra");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "host-providers.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: "opencode",
    providers
  }, null, 2) + "\\n", "utf8");
  return providers;
}

async function startHostBridge(ctx) {
  if (!ctx.experimental?.generate?.text) return null;
  const token = crypto.randomBytes(24).toString("hex");
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const send = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && url.pathname === "/health") {
      send(200, { ok: true, service: "agentorchestra-opencode-bridge" });
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/generate") {
      send(404, { error: "not found" });
      return;
    }
    if (request.headers.authorization !== "Bearer " + token) {
      send(401, { error: "unauthorized" });
      return;
    }
    let body = "";
    try {
      for await (const chunk of request) {
        body += chunk.toString();
        if (body.length > 2_000_000) throw new Error("request too large");
      }
      const parsed = JSON.parse(body || "{}");
      const model = parsed.model ?? {};
      if (!model.providerID || !model.modelID) {
        send(400, { error: "model.providerID and model.modelID are required" });
        return;
      }
      const result = await ctx.experimental.generate.text({
        model: { providerID: model.providerID, id: model.modelID },
        prompt: String(parsed.prompt ?? "")
      });
      send(200, {
        text: result?.text ?? result,
        usage: result?.usage ?? result?.tokens ?? null
      });
    } catch (error) {
      send(500, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  console.error("[agentorchestra] host execution bridge listening on 127.0.0.1:" + address.port);
  return {
    endpoint: "http://127.0.0.1:" + address.port,
    token,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export default Plugin.define({
  id: "agentorchestra",
  async setup(ctx) {
    const stateRoot = path.resolve(ctx.location.directory, ctx.options?.root ?? ".");
    const registrations = [];
    let bridge = null;
    try {
      bridge = await startHostBridge(ctx);
    } catch (error) {
      console.error("[agentorchestra] host bridge failed:", error.message);
    }
    const hostExecutor = bridge ? "host-opencode" : (ctx.options?.hostExecutor ?? "opencode");

    if (ctx.rpc?.register) {
      try {
        const config = loadConfig(stateRoot);
        const store = new Store(stateRoot, { project: "gui", policy: config.policyDefaults });
        const providers = new ProviderHub({ config, models: config.models });
        const scheduler = new Scheduler({ root: stateRoot, store, config, providers });
        registrations.push(await ctx.rpc.register(Orchestra, {
          status: async () => ({ text: JSON.stringify({ project: store.getState().project, progress: store.snapshot().progress }, null, 2) }),
          classify: async () => ({ text: JSON.stringify(classifyHostModels(stateRoot)) }),
          confirmProvider: async (input) => {
            const policy = writeProviderPolicy(stateRoot, String(input.provider), {
              billing: String(input.billing),
              privacy: String(input.privacy),
              enabled: Boolean(input.enabled)
            });
            return { text: "已确认 " + input.provider + "：" + policy.billing + " / " + policy.privacy };
          },
          examples: async () => {
            const dir = path.join(here, "examples");
            const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith(".json")) : [];
            return { text: files.map((file) => file + "\\n" + fs.readFileSync(path.join(dir, file), "utf8")).join("\\n---\\n") };
          },
          submitPlan: async (input) => {
            const plan = planFromObject(JSON.parse(String(input.plan)), config.policyDefaults);
            store.installPlan(plan, { replace: true });
            return { text: "已提交 " + plan.tasks.length + " 个任务（" + plan.project + "）" };
          },
          pool: async () => {
            const state = store.getState();
            const pool = planPool({ tasks: state.tasks, models: config.models, roles: config.roles, policy: state.policy, state });
            return { text: poolSummaryText(pool) };
          },
          routePreview: async (input) => {
            const state = store.getState();
            const task = state.tasks[String(input.taskId)];
            if (!task) return { text: "任务不存在：" + input.taskId };
            if (task.humanGate) return { text: "人工验收节点，不选择模型。" };
            if (task.kind === "script") return { text: "确定性脚本节点：" + (task.command ?? []).join(" ") };
            const route = routeTask({ task, models: config.models, roles: config.roles, policy: state.policy, state, promptChars: String(task.brief ?? "").length + 3000 });
            return { text: routePreviewText(route) };
          },
          run: async () => {
            const result = await scheduler.run({ maxSteps: 80 });
            return { text: "运行结束：" + result.stopReason + " · " + (result.progress ?? 0) + "% 接受" };
          },
          checkUpdate: async () => ({ text: updateSummaryText(await checkForUpdate(stateRoot)) }),
          update: async () => ({ text: runUpdate() })
        }));
      } catch (error) {
        console.error("[agentorchestra] RPC registration failed:", error.message);
      }
    }

    if (!ctx.mcp?.transform) throw new Error("OpenCode MCP transform API is unavailable");
    registrations.push(await ctx.mcp.transform((editor) => {
      editor.set("agentorchestra", {
        type: "local",
        command: ["node", launcher],
        environment: {
          AGENTORCHESTRA_ROOT: stateRoot,
          AGENTORCHESTRA_PLUGIN: "1",
          AGENTORCHESTRA_PLUGIN_BUILD: ctx.options?.build ?? "dev",
          AGENTORCHESTRA_HOST_ENDPOINT: bridge?.endpoint ?? "",
          AGENTORCHESTRA_HOST_TOKEN: bridge?.token ?? ""
        },
        codemode: false
      });
    }));

    try {
      await refreshHostModels(ctx, stateRoot, hostExecutor);
      await syncHostProviders(ctx, stateRoot);
    } catch (error) {
      console.error("[agentorchestra] host model sync failed:", error.message);
    }

    if (ctx.session?.hook) {
      try {
        registrations.push(await ctx.session.hook("prompt", async () => {
          try {
            await refreshHostModels(ctx, stateRoot, hostExecutor);
            await syncHostProviders(ctx, stateRoot);
          } catch (error) {
            console.error("[agentorchestra] prompt model sync failed:", error.message);
          }
        }));
      } catch (error) {
        console.error("[agentorchestra] prompt hook registration failed:", error.message);
      }
    }

    if (ctx.skill?.transform) {
      try {
        registrations.push(await ctx.skill.transform((editor) => {
          const existing = editor.get("agentorchestra");
          if (existing) {
            editor.update("agentorchestra", (skill) => {
              skill.content = skillContent;
            });
          } else {
            editor.add(makeSkillDefinition());
          }
        }));
      } catch (error) {
        console.error("[agentorchestra] skill registration failed:", error.message);
      }
    }

    if (ctx.command?.transform) {
      try {
        registrations.push(await ctx.command.transform((editor) => {
          editor.add({
            name: "orchestra-status",
            description: "Show AgentOrchestra acceptance progress, budget, locks and blockers",
            execute: async ({ sessionID, prompt, delivery }) => {
              await ctx.session.prompt({
                ...prompt,
                sessionID,
                text: "Call the agentorchestra_status MCP tool and summarize acceptance progress, budget, locks, blockers and next actions. Do not invent progress or quota.",
                delivery
              });
            }
          });
          editor.add({
            name: "orchestra-run",
            description: "Run ready AgentOrchestra nodes within the configured budget and gates",
            execute: async ({ sessionID, prompt, delivery }) => {
              await ctx.session.prompt({
                ...prompt,
                sessionID,
                text: "Call agentorchestra_status first. If no plan exists, ask before submitting one. Then call agentorchestra_run with a bounded max_steps. Report the real stop reason, evidence class, blockers and next actions. Never present simulated output as engineering evidence.",
                delivery
              });
            }
          });
          editor.add({
            name: "orchestra-models",
            description: "Refresh the host model catalogue, inspect the worker pool, and pin or unpin models",
            execute: async ({ sessionID, prompt, delivery }) => {
              try {
                await refreshHostModels(ctx, stateRoot, hostExecutor);
                await syncHostProviders(ctx, stateRoot);
              } catch (error) {
                console.error("[agentorchestra] models command sync failed:", error.message);
              }
              await ctx.session.prompt({
                ...prompt,
                sessionID,
                text: "Call agentorchestra_plan_pool and summarize the target pool size, each slot's role/model/cost/privacy, shortages and warnings. If host models have unknown billing or privacy, ask the user to confirm them, then call agentorchestra_confirm_host_models with the confirmed billing/privacy and executor; never guess or mark API models as subscription. Use agentorchestra_set_policy with pins.roles or pins.tasks when the user says to fix a model. Never silently substitute a pinned model that fails privacy, budget or quality.",
                delivery
              });
            }
          });
        }));
      } catch (error) {
        console.error("[agentorchestra] command registration failed:", error.message);
      }
    }

    try {
      void checkForUpdate(stateRoot).then((result) => {
        if (result.status === "update-available") console.log("[agentorchestra] " + updateSummaryText(result));
      });
      const updateTimer = setInterval(() => {
        void checkForUpdate(stateRoot).then((result) => {
          if (result.status === "update-available") console.log("[agentorchestra] " + updateSummaryText(result));
        });
      }, 24 * 60 * 60 * 1000);
      updateTimer.unref?.();
      registrations.push({ dispose: () => clearInterval(updateTimer) });
    } catch (error) {
      console.error("[agentorchestra] update check failed:", error.message);
    }

    return async () => {
      for (const registration of registrations.reverse()) {
        try {
          await registration.dispose?.();
        } catch {
          // best effort
        }
      }
      if (bridge) await bridge.close();
    };
  }
});
`);

write(path.join(target, "package.json"), {
  name: "agentorchestra-opencode-plugin",
  version,
  description: "OpenCode plugin for AgentOrchestra: auto-registers the local MCP server, skill and commands.",
  type: "module",
  exports: {
    ".": "./opencode-server.js",
    "./rpc": "./server/rpc.js",
    "./gui-experimental": "./gui-experimental.cjs"
  },
  files: [
    "opencode-server.js",
    "gui-experimental.cjs",
    "server",
    "config",
    "examples",
    "scripts",
    "skills",
    "hooks",
    "docs",
    "plugin.json",
    ".codex-plugin",
    "mcp.json",
    ".mcp.json",
    "README.md",
    "LICENSE"
  ],
  dependencies: {
    "@opencode/plugin": "^2.4.2"
  },
  license: "MIT"
});

write(path.join(target, "README.md"), `# AgentOrchestra plugin

This folder is the installable dual-host bundle for **Codex** and **OpenCode**. It contains the scheduler core, a stdio MCP server, the AgentOrchestra skill, and an OpenCode server plugin.

## Codex

The plugin exposes a portable \`plugin.json\`, a compatibility \`.codex-plugin/plugin.json\`, \`skills/agentorchestra/SKILL.md\`, and a stdio MCP server via \`mcp.json\` / \`.mcp.json\`.

Local repository marketplace (from the workspace root):

\`\`\`bash
codex plugin marketplace add .
codex
/plugins
\`\`\`

Alternatively copy this folder to \`~/.codex/plugins/agentorchestra\` and add a personal marketplace entry at \`~/.agents/plugins/marketplace.json\` pointing at it. See \`../docs/PLUGIN_INSTALL.md\`.

The bundled MCP server runs \`node ./server/launch-mcp.js\` with the plugin root as cwd. State defaults to \`PLUGIN_DATA\` or \`~/.agentorchestra\`; bundled \`config/\` is used as a fallback. Do not edit the installed cache for persistent policy.

## OpenCode

Add the plugin to the workspace \`opencode.json\`:

\`\`\`json
{
  "plugins": [
    { "package": "./AgentOrchestra/plugin", "options": { "root": "./AgentOrchestra" } }
  ]
}
\`\`\`

The OpenCode server part registers the local MCP server automatically, adds the AgentOrchestra skill, adds \`/orchestra-status\`, \`/orchestra-run\` and \`/orchestra-models\` commands, and refreshes the host model catalogue on setup and before each prompt. It also starts a loopback execution bridge so the scheduler can run the user's already-authenticated host models through OpenCode's own model layer instead of requiring a separate CLI or API key. Set \`hostBilling\` / \`hostPrivacy\` in plugin options only after confirming the provider's billing and data policy; unknown values stay excluded.

## Verify

\`\`\`bash
node server/cli-plugin.js doctor
node server/cli-plugin.js demo --reset
node server/cli-plugin.js status
\`\`\`

The demo is simulated; it proves orchestration only. Real engineering evidence requires a configured real provider.

## Layout

- \`server/\` — bundled scheduler, CLI and MCP server.
- \`config/\` — model catalog and policy defaults.
- \`examples/\` — starter, recursive and subsea simulation DAGs.
- \`skills/agentorchestra/SKILL.md\` — host skill.
- \`opencode-server.js\` — OpenCode server plugin.
- \`plugin.json\`, \`.codex-plugin/plugin.json\` — Codex manifests.
- \`mcp.json\`, \`.mcp.json\` — portable and compatibility MCP config.
`);

const guiBuild = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  timeout: 180000
});
const guiCandidates = [path.join(root, "dist", "gui-experimental.cjs"), path.join(root, "gui-experimental.cjs")];
const guiBundle = guiCandidates.find((file) => fs.existsSync(file));
if (guiBuild.status === 0 && guiBundle) {
  fs.copyFileSync(guiBundle, path.join(target, "gui-experimental.cjs"));
} else {
  process.stderr.write(`[agentorchestra] GUI bundle not built: ${(guiBuild.stderr ?? guiBuild.stdout ?? "").slice(-800)}\n`);
}

process.stdout.write(`Built plugin ${version} -> ${target}\n`);
process.stdout.write(`  Codex: plugin.json, .codex-plugin/plugin.json, mcp.json, .mcp.json, skills/\n`);
process.stdout.write(`  OpenCode: package.json -> opencode-server.js\n`);
