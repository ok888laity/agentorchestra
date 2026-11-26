#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveRoot } from "./config.js";
import { classifyHostModels, classificationSummaryText, writeProviderPolicy } from "./classify.js";
import { planFromObject } from "./domain.js";
import { confirmHostModels, readHostModels, syncHostModels } from "./host-models.js";
import { planPool, poolSummaryText } from "./pool.js";
import { ProviderHub } from "./providers/index.js";
import { routePreviewText, routeTask } from "./router.js";
import { Scheduler } from "./scheduler.js";
import { Store } from "./store.js";
import { nowIso } from "./util.js";

const VERSION = "0.1.0";
const PROTOCOL_VERSION = "2025-06-18";

const INSTRUCTIONS = [
  "AgentOrchestra is a cost-aware, verification-driven DAG orchestrator.",
  "Use it when a task needs more than one specialized worker, long-running resumable state, strict budget/privacy constraints, or independent review.",
  "HARD RULES: (1) L0 final decisions stay with the calling main model. (2) Never present simulated/mock output as real evidence. (3) Never send confidential task content to public/unknown-privacy models. (4) A failed gate or exhausted budget must pause or escalate, never silently accept lower quality. (5) Do not claim subscription quota values; this server reports unknown.",
  "Typical flow: orchestra_status -> orchestra_submit -> orchestra_run -> orchestra_status -> orchestra_approve / orchestra_complete_task.",
  "Use orchestra_route_preview before submitting a task if you need to understand model selection.",
  "All state is persisted under .orchestra/ and can be resumed after a restart."
].join("\n");

function textResult(value) {
  return {
    content: [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
    }]
  };
}

function errorResult(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true
  };
}

function mapPolicyArgs(args = {}) {
  const mapping = {
    quality_preference: "qualityPreference",
    billing_mode: "billingMode",
    pool_size: "poolSize",
    enforce_pool: "enforcePool",
    pins: "pins",
    api_budget_cny: "apiBudgetCny",
    max_concurrency: "maxConcurrency",
    max_depth: "maxDepth",
    max_children: "maxChildren",
    review_mode: "reviewMode",
    min_review_score: "minReviewScore",
    min_task_score: "minTaskScore",
    zero_extra_paid: "zeroExtraPaid",
    allow_unknown_privacy: "allowUnknownPrivacy",
    allow_unknown_cost: "allowUnknownCost",
    allow_scripts: "allowScripts",
    allow_delegate_l0: "allowDelegateL0",
    max_attempts: "maxAttempts",
    max_wall_minutes: "maxWallMinutes"
  };
  const patch = {};
  for (const [source, target] of Object.entries(mapping)) {
    if (Object.hasOwn(args, source)) patch[target] = args[source];
  }
  return patch;
}

function makeRuntime(root) {
  const config = loadConfig(root);
  const store = new Store(root, { project: "mcp", policy: config.policyDefaults });
  const providers = new ProviderHub({ config, models: config.models });
  const scheduler = new Scheduler({ root, store, config, providers });
  return { root, config, store, providers, scheduler };
}

const TOOLS = [
  {
    name: "orchestra_status",
    description: "Return persisted project state. Compact by default (task statuses, acceptance progress, budget, locks, blockers, human gates) to avoid dumping huge histories into model context. Set detail=true only when full routes/events/attempts are needed.",
    inputSchema: {
      type: "object",
      properties: {
        detail: { type: "boolean", default: false }
      },
      additionalProperties: false
    }
  },
  {
    name: "orchestra_plan_pool",
    description: "Plan the worker model pool/slots for the current DAG: target size, one model per role, reviewer reserve, pins, shortage reasons, free share and estimated API cost per wave.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "integer", minimum: 1, maximum: 16, description: "Override pool target; defaults to policy.poolSize or maxConcurrency." }
      },
      additionalProperties: false
    }
  },
  {
    name: "orchestra_sync_models",
    description: "Import the host harness's available model catalogue into host-models.json. Use billing/privacy only after the user confirms them; unknown values are excluded from cost-sensitive execution.",
    inputSchema: {
      type: "object",
      properties: {
        models: {
          type: "array",
          items: { type: "object" },
          description: "Host model entries (providerID/modelID/name/context/capabilities or normalized fields)."
        },
        source: { type: "string", default: "host" },
        billing: { type: "string", enum: ["free", "local", "subscription", "api", "unknown"], default: "unknown" },
        privacy: { type: "string", enum: ["local", "trusted", "public", "unknown"], default: "unknown" },
        executor: { type: "string", default: "opencode", description: "Provider adapter used to execute these models (opencode, codex, openai)." }
      },
      required: ["models"],
      additionalProperties: false
    }
  },
  {
    name: "orchestra_classify_host_models",
    description: "Classify host model providers by billing (subscription/local/api/free) and privacy candidate using model catalogue prices, provider endpoints and host auth metadata. Returns evidence, confidence and choices requiring explicit user confirmation.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "orchestra_set_provider_policy",
    description: "Persist a user-confirmed provider billing/privacy boundary into host-policy.json.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string" },
        billing: { type: "string", enum: ["free", "local", "subscription", "api", "unknown"] },
        privacy: { type: "string", enum: ["local", "trusted", "public", "unknown"] },
        enabled: { type: "boolean" },
        allowPatterns: { type: "array", items: { type: "string" } }
      },
      required: ["provider"],
      additionalProperties: false
    }
  },
  {
    name: "orchestra_confirm_host_models",
    description: "Confirm the billing and privacy boundary for all currently discovered host models. Only use after the user explicitly confirms that these models draw from a subscription/local endpoint and are acceptable for the stated data boundary.",
    inputSchema: {
      type: "object",
      properties: {
        billing: { type: "string", enum: ["free", "local", "subscription", "api"] },
        privacy: { type: "string", enum: ["local", "trusted", "public"] },
        executor: { type: "string", enum: ["opencode", "codex", "openai"], description: "Provider adapter used to execute these models." }
      },
      required: ["billing", "privacy"],
      additionalProperties: false
    }
  },
  {
    name: "orchestra_submit",
    description: "Validate and install a DAG plan. The plan must contain tasks with ids, briefs, roles, dependencies, and explicit acceptance criteria.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "object", description: "Plan object with project, policy, description and tasks[]." },
        append: { type: "boolean", description: "Append to existing tasks instead of replacing state. Default false." }
      },
      required: ["plan"],
      additionalProperties: false
    }
  },
  {
    name: "orchestra_run",
    description: "Execute ready tasks until no progress, budget exhaustion, human gate, max steps, or completion. Resumable.",
    inputSchema: {
      type: "object",
      properties: {
        max_steps: { type: "integer", minimum: 1, maximum: 200, default: 30 },
        provider: { type: "string", description: "Optional provider filter (e.g. opencode, codex, mock)." }
      },
      additionalProperties: false
    }
  },
  {
    name: "orchestra_route_preview",
    description: "Explain which model would be selected for a task, including rejected candidates and budget/privacy reasons.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        task: { type: "object", description: "Alternatively pass a task object to preview without submitting." }
      },
      additionalProperties: false
    }
  },
  {
    name: "orchestra_approve",
    description: "Approve or reject a task waiting at a human gate. Approval must be an explicit human decision.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        decision: { type: "string", enum: ["approve", "reject"] },
        note: { type: "string" }
      },
      required: ["task_id", "decision"],
      additionalProperties: false
    }
  },
  {
    name: "orchestra_complete_task",
    description: "Supply the main model's own output/artifacts for an L0 task. The deterministic acceptance gate still applies; human gates are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        output: { type: "string" },
        artifacts: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
            additionalProperties: false
          }
        },
        score: { type: "number", minimum: 0, maximum: 100 }
      },
      required: ["task_id", "output"],
      additionalProperties: false
    }
  },
  {
    name: "orchestra_set_policy",
    description: "Update routing policy: quality preference, API budget, concurrency, depth/children limits, review mode, zero-extra-paid, privacy flags.",
    inputSchema: {
      type: "object",
      properties: {
        quality_preference: { type: "integer", minimum: 0, maximum: 100 },
        billing_mode: { type: "string", enum: ["subscription", "free-first", "allow-api"] },
        pool_size: { oneOf: [{ type: "string", const: "auto" }, { type: "integer", minimum: 1, maximum: 16 }] },
        enforce_pool: { type: "boolean" },
        pins: {
          type: "object",
          properties: {
            all: { type: ["string", "null"] },
            roles: { type: "object", additionalProperties: { type: "string" } },
            tasks: { type: "object", additionalProperties: { type: "string" } }
          },
          additionalProperties: false
        },
        api_budget_cny: { type: "number", minimum: 0 },
        max_concurrency: { type: "integer", minimum: 1, maximum: 16 },
        max_depth: { type: "integer", minimum: 0, maximum: 5 },
        max_children: { type: "integer", minimum: 1, maximum: 20 },
        review_mode: { type: "string", enum: ["off", "critical", "all"] },
        min_review_score: { type: "number", minimum: 0, maximum: 100 },
        min_task_score: { type: "number", minimum: 0, maximum: 100 },
        zero_extra_paid: { type: "boolean" },
        allow_unknown_privacy: { type: "boolean" },
        allow_unknown_cost: { type: "boolean" },
        allow_scripts: { type: "boolean" },
        allow_delegate_l0: { type: "boolean" },
        max_attempts: { type: "integer", minimum: 1, maximum: 8 },
        max_wall_minutes: { type: "integer", minimum: 1, maximum: 1440 }
      },
      additionalProperties: false
    }
  },
  {
    name: "orchestra_list_models",
    description: "List the model catalog with cost class, privacy boundary, capabilities, availability and historical performance.",
    inputSchema: {
      type: "object",
      properties: {
        include_unavailable: { type: "boolean", default: false }
      },
      additionalProperties: false
    }
  },
  {
    name: "orchestra_note",
    description: "Read or add shared project memory. Notes are filtered by clearance and tags when building worker contexts.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add"], default: "list" },
        text: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        clearance: { type: "integer", minimum: 0, maximum: 2 }
      },
      additionalProperties: false
    }
  },
  {
    name: "orchestra_retry",
    description: "Reset a failed or blocked task for another attempt. Model history is cleared for that task.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false
    }
  },
  {
    name: "orchestra_control",
    description: "Pause, resume or request stop for the scheduler. Active tasks finish before the run stops.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["pause", "resume", "stop"] } },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "orchestra_doctor",
    description: "Check config, state writability, provider availability, evidence mode, and warn about unverified CLI flags.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

export function createMcpHandler({ root = resolveRoot(), runtime = null } = {}) {
  const fixedRuntime = runtime;

  function runtimeForCall() {
    return fixedRuntime ?? makeRuntime(root);
  }

  function compactStatus(snapshot) {
    return {
      project: snapshot.project,
      description: snapshot.projectDescription,
      policy: {
        qualityPreference: snapshot.policy.qualityPreference,
        apiBudgetCny: snapshot.policy.apiBudgetCny,
        zeroExtraPaid: snapshot.policy.zeroExtraPaid,
        reviewMode: snapshot.policy.reviewMode,
        maxConcurrency: snapshot.policy.maxConcurrency,
        maxDepth: snapshot.policy.maxDepth,
        maxChildren: snapshot.policy.maxChildren
      },
      progress: {
        progress: snapshot.progress.progress,
        total: snapshot.progress.total,
        accepted: snapshot.progress.accepted,
        active: snapshot.progress.active,
        waitingApproval: snapshot.progress.waitingApproval,
        waitingBudget: snapshot.progress.waitingBudget,
        needsMainModel: snapshot.progress.needsMainModel,
        blocked: snapshot.progress.blocked,
        freeShare: snapshot.progress.freeShare,
        apiSpentCny: snapshot.progress.apiSpentCny,
        simulatedResults: snapshot.progress.simulatedResults,
        simulatedOnly: snapshot.progress.simulatedOnly,
        nextActions: snapshot.progress.nextActions,
        mainModelQuota: snapshot.progress.mainModelQuota
      },
      pool: snapshot.pool ? {
        target: snapshot.pool.target,
        usableSlots: snapshot.pool.slots.length,
        distinctModels: snapshot.pool.distinctModels,
        freeShare: snapshot.pool.freeShare,
        estimatedWaveCostCny: snapshot.pool.estimatedWaveCostCny,
        billingMode: snapshot.pool.billingMode,
        slots: snapshot.pool.slots,
        shortages: snapshot.pool.shortages,
        warnings: snapshot.pool.warnings
      } : null,
      tasks: snapshot.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        group: task.group,
        tier: task.tier,
        role: task.role,
        assignedModel: task.assignedModel,
        attempts: task.attempts,
        maxAttempts: task.maxAttempts,
        score: task.score,
        deps: task.deps,
        resources: task.resources,
        error: task.error,
        blockedReason: task.blockedReason,
        reviewReason: task.reviewReason,
        simulated: task.simulated,
        artifacts: (task.artifacts ?? []).map((artifact) => artifact.name),
        parentId: task.parentId,
        children: task.children,
        integratedBy: task.integratedBy
      })),
      locks: snapshot.locks,
      warnings: snapshot.warnings,
      run: snapshot.run,
      note: "Compact status. Call again with detail=true for routes, events, attempts, gate checks and reviews; call orchestra_list_models for the catalog."
    };
  }

  async function callTool(name, args = {}) {
    const { store, scheduler, config, providers } = runtimeForCall();
    if (name === "orchestra_status") {
      const snapshot = scheduler.statusSnapshot();
      return textResult(args.detail === true ? snapshot : compactStatus(snapshot));
    }
    if (name === "orchestra_plan_pool") {
      const pool = planPool({
        tasks: Object.values(store.getState().tasks),
        models: config.models,
        roles: config.roles,
        policy: store.getState().policy,
        state: store.getState(),
        target: args.target ?? null
      });
      return textResult({ summary: poolSummaryText(pool), ...pool });
    }
    if (name === "orchestra_sync_models") {
      if (!Array.isArray(args.models)) throw new Error("models must be an array");
      const result = syncHostModels(root, {
        models: args.models,
        source: args.source ?? "host",
        billing: args.billing ?? "unknown",
        privacy: args.privacy ?? "unknown",
        executor: args.executor ?? "opencode"
      });
      return textResult({
        ok: true,
        file: result.file,
        count: result.count,
        note: "Host models were written. Confirm billing/privacy and an executor adapter before spending. The next tool call will reload the catalog.",
        next: "Call orchestra_plan_pool, then inspect any unknowns or shortages."
      });
    }
    if (name === "orchestra_classify_host_models") {
      const report = classifyHostModels(root);
      return textResult({ summary: classificationSummaryText(report), ...report });
    }
    if (name === "orchestra_set_provider_policy") {
      if (!args.provider) throw new Error("provider is required");
      const patch = {};
      for (const key of ["billing", "privacy", "enabled", "allowPatterns"]) {
        if (Object.hasOwn(args, key)) patch[key] = args[key];
      }
      const policy = writeProviderPolicy(root, args.provider, patch);
      return textResult({ ok: true, provider: args.provider, policy, note: "This policy is applied on every model load and survives host refreshes." });
    }
    if (name === "orchestra_confirm_host_models") {
      const result = confirmHostModels(root, {
        billing: args.billing,
        privacy: args.privacy,
        executor: args.executor ?? null
      });
      return textResult({
        ok: true,
        file: result.file,
        count: result.count,
        billing: result.billing,
        privacy: result.privacy,
        executor: result.executor,
        note: "The confirmation is persisted and preserved across later host catalogue refreshes. Confirm only when the user has explicitly approved the billing and data boundary."
      });
    }
    if (name === "orchestra_submit") {
      if (!args.plan || typeof args.plan !== "object") throw new Error("plan is required");
      const plan = planFromObject(args.plan, store.getState().policy);
      store.installPlan(plan, { replace: args.append !== true });
      return textResult({
        ok: true,
        project: plan.project,
        tasks: plan.tasks.length,
        policy: plan.policy,
        next: "Call orchestra_run to execute ready tasks."
      });
    }
    if (name === "orchestra_run") {
      if (scheduler.isRunning()) throw new Error("Scheduler is already running");
      const summary = await scheduler.run({
        maxSteps: args.max_steps ?? 30,
        providerFilter: args.provider ?? null
      });
      return textResult(summary);
    }
    if (name === "orchestra_route_preview") {
      let task = args.task;
      if (!task && args.task_id) task = store.getState().tasks[args.task_id];
      if (!task) throw new Error("task_id or task is required");
      if (task.humanGate) return textResult({ special: "human_gate", message: "No model is selected for a human gate." });
      if (task.kind === "script") return textResult({ special: "script", command: task.command, message: "Deterministic script node; no model selection." });
      const route = routeTask({
        task,
        models: config.models,
        roles: config.roles,
        policy: store.getState().policy,
        state: store.getState(),
        promptChars: String(task.brief ?? "").length + 3000,
        excludeModelIds: task.triedModels ?? []
      });
      return textResult({
        explanation: routePreviewText(route),
        selected: route.selected ? {
          modelId: route.selected.modelId,
          provider: route.selected.provider,
          costClass: route.selected.costClass,
          privacy: route.selected.privacy,
          quality: route.selected.quality,
          minQuality: route.minQuality,
          score: route.selected.score,
          estimateCny: route.selected.estimateCny
        } : null,
        reason: route.reason,
        reasonText: route.reasonText,
        candidates: route.candidates.slice(0, 8).map((candidate) => ({
          modelId: candidate.modelId,
          quality: candidate.quality,
          score: candidate.score,
          costClass: candidate.costClass,
          estimateCny: candidate.estimateCny
        })),
        rejected: route.rejected.slice(0, 40)
      });
    }
    if (name === "orchestra_approve") {
      if (!["approve", "reject"].includes(args.decision)) throw new Error("decision must be approve or reject");
      const result = scheduler.approveTask(args.task_id, args.decision, args.note ?? "", "mcp-client");
      return textResult({ ok: result.ok, task: result.task });
    }
    if (name === "orchestra_complete_task") {
      const result = scheduler.completeByMain(args.task_id, {
        output: args.output,
        artifacts: args.artifacts ?? [],
        score: args.score ?? null,
        actor: "mcp-main-model"
      });
      return textResult(result);
    }
    if (name === "orchestra_set_policy") {
      const patch = mapPolicyArgs(args);
      if (!Object.keys(patch).length) throw new Error("No policy fields supplied");
      const before = store.getState().policy;
      const policy = store.setPolicy(patch);
      if (policy.apiBudgetCny > before.apiBudgetCny || (before.zeroExtraPaid && !policy.zeroExtraPaid)) {
        scheduler.wakeWaitingBudget();
      }
      return textResult({ ok: true, policy });
    }
    if (name === "orchestra_list_models") {
      const models = scheduler.statusSnapshot().models
        .filter((model) => args.include_unavailable || model.available)
        .map((model) => ({
          id: model.id,
          label: model.label,
          provider: model.provider,
          costClass: model.costClass,
          privacy: model.privacy,
          available: model.available,
          contextTokens: model.contextTokens,
          capabilities: model.capabilities,
          host: Boolean(model.host),
          executor: model.executor ?? null,
          source: model.source,
          stats: model.stats
        }));
      return textResult({ models });
    }
    if (name === "orchestra_note") {
      if (args.action === "add") {
        if (!args.text) throw new Error("text is required");
        const note = store.addNote({
          text: args.text,
          tags: args.tags ?? [],
          clearance: args.clearance ?? 1,
          source: "mcp-client"
        });
        return textResult({ ok: true, note });
      }
      return textResult({ notes: store.getState().notes.slice(-50) });
    }
    if (name === "orchestra_retry") {
      const task = scheduler.retryTask(args.task_id);
      return textResult({ ok: true, task });
    }
    if (name === "orchestra_control") {
      if (args.action === "pause") scheduler.pause();
      else if (args.action === "resume") scheduler.resume();
      else if (args.action === "stop") scheduler.requestStop();
      else throw new Error("action must be pause, resume or stop");
      return textResult({ ok: true, action: args.action, paused: scheduler.isPaused(), running: scheduler.isRunning() });
    }
    if (name === "orchestra_doctor") {
      const probes = await providers.probeAll();
      const mockOnly = config.models.every((model) => model.provider.startsWith("mock"));
      return textResult({
        node: process.version,
        root,
        models: config.models.length,
        hostModels: config.hostModels?.length ?? 0,
        usableHostModels: (config.hostModels ?? []).filter((model) => model.available).length,
        unconfirmedHostModels: (config.hostModels ?? []).filter((model) => model.available && (model.costClass === "unknown" || model.privacy === "unknown")).length,
        mockOnly,
        providers: probes,
        mainModelQuota: { status: "unknown", reason: "Subscription quota is not exposed by a stable API." },
        warnings: [
          config.providers?.opencode?.verified === false ? "OpenCode CLI flags are unverified for your installed version." : null,
          config.providers?.codex?.verified === false ? "Codex CLI flags are unverified for your installed version." : null,
          mockOnly ? "All configured models are mock. Results are simulated, not engineering evidence." : null
        ].filter(Boolean)
      });
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  async function handle(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;
    if (method === "initialize") {
      const requested = params?.protocolVersion;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: requested === PROTOCOL_VERSION ? requested : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "agentorchestra", version: VERSION },
          instructions: INSTRUCTIONS
        }
      };
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      try {
        const result = await callTool(name, args);
        return { jsonrpc: "2.0", id, result };
      } catch (error) {
        return { jsonrpc: "2.0", id, result: errorResult(error.message) };
      }
    }
    if (method === "resources/list") return { jsonrpc: "2.0", id, result: { resources: [] } };
    if (method === "prompts/list") return { jsonrpc: "2.0", id, result: { prompts: [] } };
    if (method === "logging/setLevel") return { jsonrpc: "2.0", id, result: {} };
    if (isNotification) return null;
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    };
  }

  return { handle, callTool, runtime: fixedRuntime, tools: TOOLS };
}

export async function startMcpServer({ root = resolveRoot() } = {}) {
  const handler = createMcpHandler({ root });
  process.stderr.write(`[agentorchestra] MCP server ready (${root}) at ${nowIso()}\n`);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  let closed = false;

  const write = (value) => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };

  rl.on("line", (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
        return;
      }
      const response = await handler.handle(message);
      if (response) write(response);
    }).catch((error) => {
      process.stderr.write(`[agentorchestra] MCP handler error: ${error.stack}\n`);
    });
  });

  const shutdown = () => {
    if (closed) return;
    closed = true;
    rl.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await new Promise((resolve) => {
    rl.once("close", resolve);
  });
  return handler;
}

function rootFromArgv(argv) {
  const index = argv.indexOf("--root");
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return null;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  startMcpServer({ root: resolveRoot(rootFromArgv(process.argv)) }).catch((error) => {
    process.stderr.write(`[agentorchestra] MCP server failed: ${error.message}\n`);
    process.exit(1);
  });
}
