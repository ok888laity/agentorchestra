import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkForUpdate, updateCommand, updateSummaryText } from "../src/update.js";
import { cleanup, makeTempProject } from "./helpers.js";

test("update check records a baseline when git is unavailable", async (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const result = await checkForUpdate(dir);
  // 临时目录不在 git 仓库里，remote 若成功拿到就应记 baseline。
  if (result.remoteCommit) {
    assert.equal(result.status, "baseline-set");
    assert.equal(result.baselineCommit, result.remoteCommit);
    assert.match(updateSummaryText(result), /基准/);
  } else {
    assert.equal(result.status, "unknown");
    assert.match(updateSummaryText(result), /无法确认/);
  }
  const saved = JSON.parse(fs.readFileSync(path.join(dir, ".orchestra", "update-check.json"), "utf8"));
  assert.equal(saved.status, result.status);
});

test("update summary handles all states", () => {
  const base = { checkedAt: "now", baselineCommit: "aaaaaaa", remoteCommit: "bbbbbbb", localCommit: null };
  assert.match(updateSummaryText({ ...base, status: "up-to-date", remoteCommit: "aaaaaaa" }), /最新/);
  assert.match(updateSummaryText({ ...base, status: "update-available" }), /新版本/);
  assert.match(updateSummaryText({ ...base, status: "baseline-set" }), /基准/);
  assert.match(updateSummaryText({ ...base, status: "unknown", error: "offline" }), /无法确认/);
  assert.ok(updateCommand());
});
