import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin, Skill } from "@opencode/plugin";
import { syncHostModels } from "./server/host-models.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, "server", "launch-mcp.js");
const skillFile = path.join(here, "skills", "agentorchestra", "SKILL.md");
const skillContent = fs.readFileSync(skillFile, "utf8").replace(/^---[\s\S]*?---\s*/, "");
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
  }, null, 2) + "\n", "utf8");
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

