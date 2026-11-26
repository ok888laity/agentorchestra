import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createMcpHandler } from "../src/mcp.js";
import { TOOL_ROOT } from "../src/config.js";
import { cleanup, makeRuntime, makeTempProject } from "./helpers.js";

async function call(handler, id, method, params = {}) {
  return handler.handle({ jsonrpc: "2.0", id, method, params });
}

function payload(response) {
  return JSON.parse(response.result.content[0].text);
}

test("MCP handler exposes tools, installs a plan, runs it, and reports status", async (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const runtime = makeRuntime(dir);
  const handler = createMcpHandler({ root: dir, runtime });

  const init = await call(handler, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } });
  assert.equal(init.result.serverInfo.name, "agentorchestra");
  assert.equal(init.result.protocolVersion, "2025-06-18");

  const tools = await call(handler, 2, "tools/list");
  assert.ok(tools.result.tools.length >= 8);
  assert.ok(tools.result.tools.some((tool) => tool.name === "orchestra_submit"));

  const starter = JSON.parse(fs.readFileSync(path.join(dir, "examples", "starter.json"), "utf8"));
  const submit = await call(handler, 3, "tools/call", {
    name: "orchestra_submit",
    arguments: { plan: starter }
  });
  assert.equal(submit.result.isError, undefined);
  assert.equal(payload(submit).tasks, 8);

  const run = await call(handler, 4, "tools/call", {
    name: "orchestra_run",
    arguments: { max_steps: 80 }
  });
  const summary = payload(run);
  assert.equal(summary.stopReason, "needs_approval");
  assert.equal(summary.accepted, 7);

  const status = await call(handler, 5, "tools/call", { name: "orchestra_status", arguments: {} });
  assert.equal(payload(status).tasks.find((task) => task.id === "approval").status, "waiting_approval");

  const approve = await call(handler, 6, "tools/call", {
    name: "orchestra_approve",
    arguments: { task_id: "approval", decision: "approve", note: "test" }
  });
  assert.equal(payload(approve).task.status, "done");

  const models = await call(handler, 7, "tools/call", {
    name: "orchestra_list_models",
    arguments: { include_unavailable: false }
  });
  assert.ok(payload(models).models.length > 0);

  const badGate = await call(handler, 8, "tools/call", {
    name: "orchestra_complete_task",
    arguments: { task_id: "approval", output: "human gate bypass" }
  });
  assert.equal(badGate.result.isError, true);
});

test("MCP stdio entry point speaks newline-delimited JSON-RPC", async (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const child = spawn(process.execPath, [path.join(TOOL_ROOT, "src", "mcp.js"), "--root", dir], {
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
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-test" } }
  })}\n`);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP stdio timeout. stdout=${stdout} stderr=${stderr}`)), 8000);
    const check = () => {
      if (stdout.includes("\n")) {
        clearTimeout(timer);
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
  const line = stdout.split(/\r?\n/).find(Boolean);
  const response = JSON.parse(line);
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, "agentorchestra");
  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
});
