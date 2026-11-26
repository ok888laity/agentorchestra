import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { TOOL_ROOT } from "../src/config.js";
import { Orchestra } from "../gui-src/rpc.js";

test("dual-host plugin bundle validates and its bundled MCP server handshakes", () => {
  const output = execFileSync(process.execPath, [path.join(TOOL_ROOT, "scripts", "verify-plugin.js")], {
    cwd: TOOL_ROOT,
    encoding: "utf8",
    timeout: 30_000
  });
  assert.match(output, /\[ok\] Codex portable manifest/);
  assert.match(output, /\[ok\] single manifest identity/);
  assert.match(output, /\[ok\] portable stdio MCP config/);
  assert.match(output, /\[ok\] OpenCode plugin package/);
  assert.match(output, /\[ok\] bundled MCP stdio handshake/);
  assert.equal(output.includes("[!!]"), false, output);
});

test("every RPC method declares input and output schemas (OpenCode 2.4.2 compatibility)", () => {
  for (const [name, method] of Object.entries(Orchestra.methods)) {
    assert.ok(method.input, `${name}.input missing`);
    assert.ok(method.output, `${name}.output missing`);
  }
  assert.ok(Orchestra.methods.checkUpdate, "checkUpdate method missing");
});
