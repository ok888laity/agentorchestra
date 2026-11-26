import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizeModel } from "../config.js";
import { estimateCostCny } from "../registry.js";
import { tail } from "../util.js";

const WINDOWS = process.platform === "win32";

function quoteWindowsArg(value) {
  const arg = String(value);
  if (!arg) return '""';
  if (/[&|<>^%!\r\n]/.test(arg)) {
    throw new Error(`Refusing to pass a Windows CLI argument containing shell metacharacters: ${arg}`);
  }
  if (/^[A-Za-z0-9_./:=+@-]+$/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '\\"')}"`;
}

function buildInvocation(command, args) {
  if (WINDOWS) {
    return {
      command: [command, ...args].map(quoteWindowsArg).join(" "),
      args: [],
      options: { shell: true }
    };
  }
  return { command, args, options: { shell: false } };
}

function killTree(child) {
  if (!child?.pid) return;
  if (WINDOWS) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

function runProcess({ command, args, cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    const invocation = buildInvocation(command, args);
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = null;
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        env,
        windowsHide: true,
        ...invocation.options
      });
    } catch (error) {
      resolve({ stdout, stderr, code: -1, timedOut, spawnError: error, durationMs: 0 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 2_000_000) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 2_000_000) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      spawnError = error;
      clearTimeout(timer);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut, spawnError, durationMs: Date.now() - started });
    });
  });
}

export class CliProvider {
  constructor({ name, config = {} }) {
    this.name = name;
    this.config = config;
  }

  command() {
    return this.config.command ?? this.name;
  }

  async probe() {
    const command = this.command();
    const result = spawnSync(WINDOWS ? `${quoteWindowsArg(command)} --version` : command, WINDOWS ? [] : ["--version"], {
      shell: WINDOWS,
      windowsHide: true,
      timeout: 8000,
      encoding: "utf8"
    });
    if (result.error) return { available: false, detail: `not found: ${result.error.message}` };
    if (result.status !== 0) {
      const debug = process.env.AGENTORCHESTRA_DEBUG ? `: ${tail(result.stderr || result.stdout, 300)}` : "";
      return { available: false, detail: `command not available (exit ${result.status})${debug}` };
    }
    return { available: true, detail: (result.stdout || result.stderr || "command available").trim().split(/\r?\n/)[0] };
  }

  async run({ model, prompt, cwd, root = process.cwd(), timeoutMs = 25 * 60 * 1000, task }) {
    const command = this.command();
    const argsTemplate = this.config.args ?? [];
    const remoteModel = model.remoteModel || model.id;
    const promptFile = path.join(cwd, "TASK.md");
    fs.writeFileSync(promptFile, prompt, "utf8");
    const args = argsTemplate.map((item) => String(item)
      .replaceAll("{model}", remoteModel)
      .replaceAll("{cwd}", cwd)
      .replaceAll("{promptFile}", promptFile)
      .replaceAll("{taskId}", task?.id ?? "")
      .replaceAll("{root}", root));
    const env = {
      ...process.env,
      AGENTORCHESTRA_TASK_ID: task?.id ?? "",
      AGENTORCHESTRA_MODEL: remoteModel,
      AGENTORCHESTRA_PROVIDER: this.name
    };
    const result = await runProcess({ command, args, cwd, timeoutMs, env });
    if (result.spawnError) throw new Error(`Failed to start ${command}: ${result.spawnError.message}`);
    if (result.timedOut) throw new Error(`${command} timed out after ${Math.round(timeoutMs / 60000)} minutes`);
    if (result.code !== 0) {
      throw new Error(`${command} exited ${result.code}: ${tail(result.stderr || result.stdout, 2000)}`);
    }
    const output = (result.stdout || result.stderr || "").trim();
    if (!output) throw new Error(`${command} produced no output`);
    const tokensIn = Math.ceil(prompt.length / 3);
    const tokensOut = Math.ceil(output.length / 3);
    return {
      output,
      artifacts: [],
      tokensIn,
      tokensOut,
      costCny: estimateCostCny(model, { input: tokensIn, output: tokensOut }),
      latencyMs: result.durationMs,
      meta: {
        provider: this.name,
        modelId: model.id,
        remoteModel,
        simulated: false,
        evidenceClass: "real",
        command,
        exitCode: result.code,
        workspaceScan: true
      }
    };
  }

  async discover() {
    const command = this.config.modelsCommand;
    if (!Array.isArray(command) || !command.length) return [];
    const [exe, ...args] = command;
    const result = await runProcess({ command: exe, args, cwd: process.cwd(), timeoutMs: 60_000, env: process.env });
    if (result.code !== 0) throw new Error(`Discovery command failed: ${tail(result.stderr || result.stdout, 800)}`);
    const lines = (result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const models = [];
    for (const line of lines) {
      if (/^(provider|models?|available|#|-+)/i.test(line)) continue;
      if (line.length > 160 || /\s{2,}/.test(line)) continue;
      const remoteModel = line.split(/\s+/)[0];
      if (!/^[\w./:-]+$/.test(remoteModel)) continue;
      models.push(normalizeModel({
        id: `${this.name}/${remoteModel}`,
        provider: this.name,
        remoteModel,
        label: remoteModel,
        costClass: "unknown",
        privacy: "unknown",
        available: true,
        contextTokens: 128000,
        capabilities: {
          reasoning: 50,
          coding: 50,
          research: 50,
          writing: 50,
          design: 50,
          review: 50,
          tools: 50,
          multimodal: 0,
          speed: 50
        },
        notes: "Discovered from CLI. Privacy and cost are unknown until you configure config/models.local.json."
      }, "discovered"));
    }
    return models;
  }
}
