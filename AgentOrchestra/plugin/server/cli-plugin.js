import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
process.env.AGENTORCHESTRA_ROOT ||= process.env.PLUGIN_DATA || path.join(os.homedir(), ".agentorchestra");
const fixture = path.join(pluginRoot, "scripts", "demo-check.js");
if (fs.existsSync(fixture)) {
  fs.mkdirSync(path.join(process.env.AGENTORCHESTRA_ROOT, "scripts"), { recursive: true });
  fs.copyFileSync(fixture, path.join(process.env.AGENTORCHESTRA_ROOT, "scripts", "demo-check.js"));
}
await import("./cli.js");

