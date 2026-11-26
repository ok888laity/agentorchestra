import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMcpServer } from "./mcp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const dataRoot = process.env.AGENTORCHESTRA_ROOT
  || process.env.PLUGIN_DATA
  || path.join(os.homedir(), ".agentorchestra");
process.env.AGENTORCHESTRA_ROOT = dataRoot;

// The starter demo references {root}/scripts/demo-check.js. Keep the
// deterministic fixture available in the writable data root.
const fixture = path.join(pluginRoot, "scripts", "demo-check.js");
if (fs.existsSync(fixture)) {
  fs.mkdirSync(path.join(dataRoot, "scripts"), { recursive: true });
  fs.copyFileSync(fixture, path.join(dataRoot, "scripts", "demo-check.js"));
}

startMcpServer({ root: dataRoot }).catch((error) => {
  process.stderr.write(`[agentorchestra] plugin MCP failed: ${error.message}\n`);
  process.exit(1);
});

