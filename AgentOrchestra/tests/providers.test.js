import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { atomicWriteJson, readJson } from "../src/util.js";
import { planFromObject } from "../src/domain.js";
import { cleanup, makeRuntime, makeTempProject } from "./helpers.js";

function addProvider(dir, name, config) {
  const file = path.join(dir, "config", "providers.json");
  const doc = readJson(file);
  doc.providers[name] = config;
  atomicWriteJson(file, doc);
}

function addModel(dir, model) {
  const file = path.join(dir, "config", "models.local.json");
  const doc = fs.existsSync(file) ? readJson(file) : { models: [] };
  doc.models.push(model);
  atomicWriteJson(file, doc);
}

function baseTask(overrides = {}) {
  return {
    id: "fixture-task",
    title: "Fixture task",
    brief: "Produce a fixture with explicit evidence.",
    group: "fixture",
    kind: "doc",
    tier: "L2",
    role: "documenter",
    difficulty: 2,
    confidentiality: 0,
    deps: [],
    acceptance: {
      minChars: 60,
      mustContain: ["FIXTURE"],
      artifacts: ["fixture.md"],
      requireEvidence: true
    },
    ...overrides
  };
}

test("CLI provider runs a command, scans artifacts, and records real evidence", async (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  fs.writeFileSync(path.join(dir, "scripts", "fake-cli.js"), [
    'import fs from "node:fs";',
    'import path from "node:path";',
    "const cwd = process.argv[2];",
    "const task = fs.readFileSync(path.join(cwd, 'TASK.md'), 'utf8');",
    "fs.writeFileSync(path.join(cwd, 'fixture.md'), '# CLI fixture\\n\\nFIXTURE\\n\\n## Evidence\\n- Evidence class: real\\n- Command: fake-cli\\n- Output: ok\\n');",
    "console.log('fake-cli completed the task');"
  ].join("\n"));
  addProvider(dir, "fake-cli", {
    type: "cli",
    command: "node",
    args: ["{root}/scripts/fake-cli.js", "{cwd}"],
    timeoutMinutes: 2
  });
  addModel(dir, {
    id: "fake-cli/fixture",
    provider: "fake-cli",
    label: "Fake CLI fixture",
    costClass: "free",
    privacy: "local",
    available: true,
    contextTokens: 32000,
    capabilities: { reasoning: 90, coding: 90, research: 90, writing: 90, design: 90, review: 90, tools: 90, multimodal: 0, speed: 90 }
  });

  const runtime = makeRuntime(dir);
  const plan = planFromObject({
    project: "cli-fixture",
    policy: { reviewMode: "off", qualityPreference: 50 },
    tasks: [baseTask()]
  }, runtime.config.policyDefaults);
  runtime.store.installPlan(plan, { replace: true });
  const summary = await runtime.scheduler.run({ maxSteps: 10, providerFilter: "fake-cli" });
  assert.equal(summary.stopReason, "complete");
  const task = runtime.store.getState().tasks["fixture-task"];
  assert.equal(task.status, "done");
  assert.equal(task.assignedModel, "fake-cli/fixture");
  assert.equal(task.result.meta.simulated, false);
  assert.equal(task.result.gate.evidenceClass, "real");
  const artifact = fs.readFileSync(path.join(dir, "artifacts", "fixture-task", "latest", "fixture.md"), "utf8");
  assert.match(artifact, /CLI fixture/);
  assert.match(artifact, /Evidence class: real/);
});

test("host-http bridge executes an already-authenticated host model", async (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  let received = null;
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => {
      if (request.headers.authorization !== "Bearer bridge-token") {
        response.writeHead(401);
        response.end("unauthorized");
        return;
      }
      received = JSON.parse(body);
      const content = [
        "# Host bridge fixture",
        "",
        "FIXTURE",
        "",
        "## Evidence",
        "- Evidence class: real",
        "- Command: host bridge",
        "- Output: ok",
        "",
        "```artifact path=fixture.md",
        "# Host artifact",
        "FIXTURE",
        "```"
      ].join("\n");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ text: content, usage: { input: 100, output: 60 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  addProvider(dir, "host-opencode", {
    type: "host-http",
    endpoint: `http://127.0.0.1:${port}`,
    token: "bridge-token",
    timeoutMinutes: 1
  });
  addModel(dir, {
    id: "host-opencode/fixture",
    provider: "host-opencode",
    remoteModel: "opencode/host-model",
    label: "Host bridge fixture",
    costClass: "subscription",
    privacy: "local",
    available: true,
    contextTokens: 32000,
    inputCostCnyPerMTok: 0,
    outputCostCnyPerMTok: 0,
    capabilities: { reasoning: 90, coding: 90, research: 90, writing: 90, design: 90, review: 90, tools: 90, multimodal: 0, speed: 90 }
  });

  const runtime = makeRuntime(dir);
  const plan = planFromObject({
    project: "host-bridge",
    policy: { reviewMode: "off", qualityPreference: 50, billingMode: "subscription" },
    tasks: [baseTask({ id: "host-task" })]
  }, runtime.config.policyDefaults);
  runtime.store.installPlan(plan, { replace: true });
  const summary = await runtime.scheduler.run({ maxSteps: 10, providerFilter: "host-opencode" });
  assert.equal(summary.stopReason, "complete");
  const task = runtime.store.getState().tasks["host-task"];
  assert.equal(task.status, "done");
  assert.equal(task.result.meta.simulated, false);
  assert.equal(task.result.gate.evidenceClass, "real");
  assert.equal(received.model.providerID, "opencode");
  assert.equal(received.model.modelID, "host-model");
  const artifact = fs.readFileSync(path.join(dir, "artifacts", "host-task", "latest", "fixture.md"), "utf8");
  assert.match(artifact, /Host artifact/);
});

test("OpenAI-compatible provider sends a request and persists an artifact block", async (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  let received = null;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk.toString(); });
    request.on("end", () => {
      received = JSON.parse(body);
      const content = [
        "# HTTP fixture",
        "",
        "FIXTURE",
        "",
        "## Evidence",
        "- Evidence class: real",
        "- Command: local HTTP fixture",
        "- Output: ok",
        "",
        "```artifact path=fixture.md",
        "# HTTP artifact",
        "FIXTURE",
        "```"
      ].join("\n");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "fixture-response",
        choices: [{ message: { content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 120, completion_tokens: 80 }
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  addProvider(dir, "openai", {
    type: "openai",
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKeyEnv: "AGENTORCHESTRA_TEST_KEY",
    timeoutMinutes: 1,
    requiresKey: false
  });
  addModel(dir, {
    id: "openai/fixture",
    provider: "openai",
    remoteModel: "fixture-model",
    label: "Local HTTP fixture",
    costClass: "local",
    privacy: "local",
    available: true,
    contextTokens: 32000,
    inputCostCnyPerMTok: 0,
    outputCostCnyPerMTok: 0,
    capabilities: { reasoning: 90, coding: 90, research: 90, writing: 90, design: 90, review: 90, tools: 90, multimodal: 0, speed: 90 }
  });

  const runtime = makeRuntime(dir);
  const plan = planFromObject({
    project: "http-fixture",
    policy: { reviewMode: "off", qualityPreference: 50, zeroExtraPaid: true },
    tasks: [baseTask({ id: "http-task" })]
  }, runtime.config.policyDefaults);
  runtime.store.installPlan(plan, { replace: true });
  const summary = await runtime.scheduler.run({ maxSteps: 10, providerFilter: "openai" });
  assert.equal(summary.stopReason, "complete");
  const task = runtime.store.getState().tasks["http-task"];
  assert.equal(task.status, "done");
  assert.equal(task.result.meta.simulated, false);
  assert.equal(task.result.gate.evidenceClass, "real");
  assert.equal(received.model, "fixture-model");
  assert.ok(received.messages[0].content.includes("Fixture task"));
  const artifact = fs.readFileSync(path.join(dir, "artifacts", "http-task", "latest", "fixture.md"), "utf8");
  assert.match(artifact, /HTTP artifact/);
});

