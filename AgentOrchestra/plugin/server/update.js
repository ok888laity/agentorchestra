import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = "ok888laity/agentorchestra";

function gitCommit(root) {
  const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function commandExists(name) {
  const r = spawnSync(name, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  return !r.error && r.status === 0;
}

export async function checkForUpdate(root) {
  const file = path.join(root, ".orchestra", "update-check.json");
  const prior = readJson(file);
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

  // 基准优先级：git commit（源码仓库最准） > 上次记住的基准 > 上次 up-to-date 的远端。
  const git = gitCommit(root);
  const baseline = git ?? prior?.baselineCommit ?? (prior?.status === "up-to-date" ? prior?.remoteCommit : null) ?? null;
  let status = "unknown";
  let baselineSet = false;
  if (!error && remote) {
    if (!baseline) {
      // 首次运行且没有 git：把当前远端记为基准，之后再对比。
      status = "baseline-set";
      baselineSet = true;
    } else {
      status = remote === baseline ? "up-to-date" : "update-available";
    }
  }

  const savedBaseline = baselineSet ? remote : baseline;
  const result = {
    checkedAt: new Date().toISOString(),
    repo: REPO,
    localCommit: git,
    baselineCommit: savedBaseline,
    remoteCommit: remote,
    status,
    error
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

export function updateCommand() {
  if (commandExists("opencode")) return "opencode plugin update agentorchestra@agentorchestra-local";
  if (commandExists("codex")) {
    return "codex plugin remove agentorchestra@agentorchestra-local && codex plugin add agentorchestra@agentorchestra-local";
  }
  return "从 GitHub 重新安装 agentorchestra 插件";
}

export function updateSummaryText(result) {
  const short = (value) => value ? String(value).slice(0, 7) : "unknown";
  if (result.status === "up-to-date") return `AgentOrchestra 已是最新（${short(result.remoteCommit)}）。检查时间 ${result.checkedAt}`;
  if (result.status === "update-available") {
    return `发现新版本：${short(result.baselineCommit)} → ${short(result.remoteCommit)}。\n`
      + `更新命令：${updateCommand()}\n检查时间 ${result.checkedAt}`;
  }
  if (result.status === "baseline-set") {
    return `已记录更新基准 ${short(result.remoteCommit)}。下次检查即可发现新版本。\n检查时间 ${result.checkedAt}`;
  }
  return `无法确认更新状态：${result.error ?? "GitHub 无响应"}。检查时间 ${result.checkedAt}`;
}

export function runUpdate() {
  if (commandExists("opencode")) {
    const result = spawnSync("opencode", ["plugin", "update", "agentorchestra@agentorchestra-local"], {
      encoding: "utf8", windowsHide: true, timeout: 180000
    });
    if (result.error) return `更新失败：${result.error.message}`;
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    return result.status === 0 ? (output || "更新完成，请重启 OpenCode。") : `更新命令退出码 ${result.status}：${output}`;
  }
  // Codex 的 remove/add 会中断当前会话，只给命令让用户自己执行。
  return `请在新终端执行：${updateCommand()}`;
}
