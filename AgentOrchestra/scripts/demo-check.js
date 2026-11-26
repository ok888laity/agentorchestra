import fs from "node:fs";
import path from "node:path";

const payload = {
  status: "ok",
  checkedAt: new Date().toISOString(),
  node: process.version,
  cwd: process.cwd(),
  fixture: "agentorchestra-deterministic-check-v1"
};

fs.writeFileSync(path.join(process.cwd(), "check.json"), JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload));
