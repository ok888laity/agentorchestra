import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { startDashboard } from "../src/dashboard.js";
import { cleanup, makeTempProject } from "./helpers.js";

async function withDashboard(t, root, fn) {
  const server = await startDashboard({ root, port: 0, host: "127.0.0.1" });
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;
  return fn(base);
}

async function post(base, pathname, body) {
  const response = await fetch(base + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
}

test("dashboard UI endpoints cover classification, plan, route preview and pool", async (t) => {
  const root = makeTempProject();
  t.after(() => cleanup(root));
  await withDashboard(t, root, async (base) => {
    const examples = await (await fetch(base + "/api/examples")).json();
    assert.ok(examples.examples.some((item) => item.name === "starter.json"));

    const plan = await post(base, "/api/plan", { file: "starter.json" });
    assert.equal(plan.status, 200);
    assert.equal(plan.data.tasks, 8);

    const preview = await post(base, "/api/route-preview", { taskId: "brief" });
    assert.equal(preview.status, 200);
    assert.ok(preview.data.route.selected?.modelId || preview.data.route.reasonText);

    const pool = await post(base, "/api/pool", {});
    assert.equal(pool.status, 200);
    assert.ok(pool.data.pool.target >= 1);
    assert.ok(Array.isArray(pool.data.pool.slots));

    const classification = await (await fetch(base + "/api/classification")).json();
    assert.ok(Array.isArray(classification.groups));

    const policy = await post(base, "/api/provider-policy", {
      provider: "opencode-go", billing: "subscription", privacy: "trusted", enabled: true
    });
    assert.equal(policy.status, 200);
    assert.equal(policy.data.policy.privacy, "trusted");
    const saved = JSON.parse(fs.readFileSync(path.join(root, ".orchestra", "host-policy.json"), "utf8"));
    assert.equal(saved.providers["opencode-go"].userChoice, true);
  });
});

test("dashboard rejects cross-origin POST", async (t) => {
  const root = makeTempProject();
  t.after(() => cleanup(root));
  await withDashboard(t, root, async (base) => {
    const response = await fetch(base + "/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ file: "starter.json" })
    });
    assert.equal(response.status, 403);
  });
});
