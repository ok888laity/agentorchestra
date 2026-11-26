import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Workspace } from "../src/workspace.js";
import { cleanup, makeTempProject } from "./helpers.js";

test("artifact versions are retained and latest points to the newest content", (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const workspace = new Workspace(dir);
  workspace.persistArtifacts("task", 1, [{ path: "out.md", content: "version one" }]);
  workspace.persistArtifacts("task", 2, [{ path: "out.md", content: "version two" }]);
  assert.equal(workspace.readArtifact("task", "latest/out.md"), "version two");
  assert.equal(workspace.readArtifact("task", "attempt-1/out.md"), "version one");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "task", "manifest.json"), "utf8"));
  assert.equal(manifest.versions.length, 2);
});

test("path traversal in artifact names is rejected", (t) => {
  const dir = makeTempProject();
  t.after(() => cleanup(dir));
  const workspace = new Workspace(dir);
  assert.throws(() => workspace.persistArtifacts("task", 1, [{ path: "../escape.md", content: "x" }]), /Unsafe/);
});
