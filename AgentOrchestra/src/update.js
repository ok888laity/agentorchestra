import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = "ok888laity/agentorchestra";

function localCommit(root) {
  const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export async function checkForUpdate(root) {
  const file = path.join(root, ".orchestra", "update-check.json");
  let remote = null;
  let error = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "agentorchestra-update-check" },
        signal: controller.signal
      });
      if (response.ok) {
        const data = await response.json();
        remote = data.sha ?? null;
      } else {
        error = `GitHub HTTP ${response.status}`;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (caught) {
    error = caught?.name === "AbortError" ? "GitHub 请求超时" : String(caught?.message ?? caught);
  }

  const local = localCommit(root);
  const result = {
    checkedAt: new Date().toISOString(),
    repo: REPO,
    localCommit: local,
    remoteCommit: remote,
    status: error ? "unknown" : (remote && local ? (remote === local ? "up-to-date" : "update-available") : "unknown"),
    error
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

export function updateSummaryText(result) {
  if (result.status === "up-to-date") return `AgentOrchestra 已是最新（${String(result.localCommit).slice(0, 7)}）。检查时间 ${result.checkedAt}`;
  if (result.status === "update-available") {
    return `发现新版本：本地 ${String(result.localCommit).slice(0, 7)} → 远端 ${String(result.remoteCommit).slice(0, 7)}。\n`
      + `更新命令：opencode plugin update agentorchestra@agentorchestra-local\n检查时间 ${result.checkedAt}`;
  }
  return `无法确认更新状态：${result.error ?? "缺少本地 commit 或远端响应"}。检查时间 ${result.checkedAt}`;
}

export function runUpdate() {
  const result = spawnSync("opencode", ["plugin", "update", "agentorchestra@agentorchestra-local"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 180000
  });
  if (result.error) return `更新失败：${result.error.message}`;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return result.status === 0 ? (output || "更新完成，请重启 OpenCode。") : `更新命令退出码 ${result.status}：${output}`;
}
