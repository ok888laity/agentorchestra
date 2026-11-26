import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { classifyHostModels } from "../src/classify.js";
import { confirmHostModels, syncHostModels } from "../src/host-models.js";
import { cleanup, makeTempProject } from "./helpers.js";

test("confirmHostModels persists to user policy so classifier stops asking", (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  syncHostModels(dir, {
    source: "codex",
    billing: "subscription",
    privacy: "unknown",
    executor: "codex",
    models: [
      { providerID: "codex", id: "gpt-x", remoteModel: "codex/gpt-x", name: "GPT X", available: true }
    ]
  });
  const before = classifyHostModels(dir);
  assert.ok(before.choicesRequired.length > 0, "should ask before confirmation");

  confirmHostModels(dir, { billing: "subscription", privacy: "trusted", executor: "codex" });

  const saved = JSON.parse(fs.readFileSync(path.join(dir, ".orchestra", "host-policy.json"), "utf8"));
  assert.equal(saved.providers.codex.userChoice, true);
  assert.equal(saved.providers.codex.privacy, "trusted");

  const after = classifyHostModels(dir);
  assert.equal(after.choicesRequired.length, 0, "should not ask after confirmation");
});
