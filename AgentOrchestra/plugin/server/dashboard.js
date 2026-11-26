import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveRoot } from "./config.js";
import { ProviderHub } from "./providers/index.js";
import { Scheduler } from "./scheduler.js";
import { Store } from "./store.js";
import { clamp, nowIso } from "./util.js";

const VERSION = "0.1.0";
const HTML_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "dashboard.html");

function isLoopback(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(host);
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

function sendText(response, status, value, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(value);
}

function readBody(request, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > limit) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });
    request.on("error", reject);
  });
}

function originAllowed(request, host, port) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) return false;
    return !parsed.port || parsed.port === String(port);
  } catch {
    return false;
  }
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // opening a browser is best-effort
  }
}

export async function startDashboard({ root = resolveRoot(), port = 8765, host = "127.0.0.1", open = false } = {}) {
  if (!isLoopback(host)) {
    throw new Error("AgentOrchestra V1 dashboard only binds to loopback. Use an SSH tunnel or a reverse proxy with authentication for remote access.");
  }
  const html = fs.readFileSync(HTML_FILE, "utf8");
  let lastRunError = null;
  let activeRuntime = null;

  function createRuntime() {
    const config = loadConfig(root);
    const store = new Store(root, { project: "dashboard", policy: config.policyDefaults });
    const providers = new ProviderHub({ config, models: config.models });
    const scheduler = new Scheduler({ root, store, config, providers });
    return { root, config, store, providers, scheduler };
  }

  function currentRuntime() {
    if (activeRuntime?.scheduler.isRunning()) return activeRuntime;
    return createRuntime();
  }

  const snapshot = (runtime = currentRuntime()) => ({
    ...runtime.scheduler.statusSnapshot(),
    dashboard: {
      root,
      version: VERSION,
      node: process.version,
      now: nowIso(),
      lastRunError
    }
  });

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host ?? `${host}:${port}`}`);
      if (request.method === "POST" && !originAllowed(request, host, port)) {
        sendJson(response, 403, { error: "Origin not allowed" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/") {
        sendText(response, 200, html, "text/html; charset=utf-8");
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        sendJson(response, 200, snapshot());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, {
          ok: true,
          version: VERSION,
          running: Boolean(activeRuntime?.scheduler.isRunning()),
          now: nowIso()
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/artifact") {
        const taskId = url.searchParams.get("task");
        const artifactPath = url.searchParams.get("path");
        if (!taskId || !artifactPath || !artifactPath.startsWith("latest/")) {
          sendJson(response, 400, { error: "task and latest/ path are required" });
          return;
        }
        const runtime = currentRuntime();
        if (!runtime.store.getState().tasks[taskId]) {
          sendJson(response, 404, { error: "Unknown task" });
          return;
        }
        const content = runtime.scheduler.workspace.readArtifact(taskId, artifactPath);
        sendText(response, 200, content);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/policy") {
        const body = await readBody(request);
        const allowed = [
          "qualityPreference", "billingMode", "poolSize", "apiBudgetCny", "maxConcurrency", "maxDepth", "maxChildren",
          "reviewMode", "minReviewScore", "minTaskScore", "zeroExtraPaid", "allowUnknownPrivacy",
          "allowUnknownCost", "maxAttempts", "maxWallMinutes", "allowScripts", "requireCrossProviderReview",
          "allowDelegateL0", "stagnationLimit"
        ];
        const patch = {};
        for (const key of allowed) {
          if (Object.hasOwn(body, key)) patch[key] = body[key];
        }
        if (!Object.keys(patch).length) {
          sendJson(response, 400, { error: "No policy fields supplied" });
          return;
        }
        const runtime = currentRuntime();
        const before = runtime.store.getState().policy;
        const policy = runtime.store.setPolicy(patch);
        if (policy.apiBudgetCny > before.apiBudgetCny || (before.zeroExtraPaid && !policy.zeroExtraPaid)) {
          runtime.scheduler.wakeWaitingBudget();
        }
        sendJson(response, 200, snapshot(runtime));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/run") {
        if (activeRuntime?.scheduler.isRunning()) {
          sendJson(response, 409, { error: "Scheduler is already running" });
          return;
        }
        const runtime = createRuntime();
        if (!Object.keys(runtime.store.getState().tasks).length) {
          sendJson(response, 400, { error: "No plan installed" });
          return;
        }
        const body = await readBody(request);
        const maxSteps = clamp(Number(body.maxSteps ?? 50), 1, 500);
        lastRunError = null;
        activeRuntime = runtime;
        runtime.scheduler.run({ maxSteps, providerFilter: body.providerFilter ?? null }).catch((error) => {
          lastRunError = error.message;
          runtime.store.recordEvent("error", "dashboard.run_failed", error.message, {});
          process.stderr.write(`[agentorchestra] dashboard run failed: ${error.message}\n`);
        }).finally(() => {
          if (activeRuntime === runtime) activeRuntime = null;
        });
        sendJson(response, 202, { started: true, maxSteps });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/approve") {
        const body = await readBody(request);
        if (!body.taskId) {
          sendJson(response, 400, { error: "taskId is required" });
          return;
        }
        const runtime = currentRuntime();
        runtime.scheduler.approveTask(body.taskId, body.decision === "reject" ? "reject" : "approve", String(body.note ?? ""), "dashboard");
        sendJson(response, 200, snapshot(runtime));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/retry") {
        const body = await readBody(request);
        if (!body.taskId) {
          sendJson(response, 400, { error: "taskId is required" });
          return;
        }
        const runtime = currentRuntime();
        runtime.scheduler.retryTask(body.taskId);
        sendJson(response, 200, snapshot(runtime));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/pause") {
        const runtime = currentRuntime();
        runtime.scheduler.pause();
        sendJson(response, 200, snapshot(runtime));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/resume") {
        const runtime = currentRuntime();
        runtime.scheduler.resume();
        sendJson(response, 200, snapshot(runtime));
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      process.stderr.write(`[agentorchestra] dashboard request failed: ${error.stack}\n`);
      if (!response.headersSent) sendJson(response, 500, { error: error.message });
      else response.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;
  process.stdout.write(`AgentOrchestra dashboard: ${url}\n`);
  process.stdout.write(`State root: ${root}\n`);
  process.stdout.write("Loopback only. Press Ctrl+C to stop. Active tasks are recovered on the next run.\n");
  if (open) openBrowser(url);

  const shutdown = () => {
    if (activeRuntime?.scheduler.isRunning()) activeRuntime.scheduler.requestStop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return server;
}
