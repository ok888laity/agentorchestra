import fs from "node:fs";
import path from "node:path";
import {
  atomicWriteJson,
  ensureDir,
  nowIso,
  readJson,
  safeJoin,
  sanitizeRelativePath,
  sha256
} from "./util.js";

const SKIP_DIRS = new Set(["node_modules", ".git", ".orchestra", "__pycache__", ".venv", "venv"]);
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".cs", ".cpp", ".h", ".hpp",
  ".java", ".go", ".rs", ".rb", ".php", ".html", ".css", ".scss", ".csv", ".yaml", ".yml", ".toml", ".ini",
  ".scad", ".dxf", ".svg", ".xml", ".sql", ".sh", ".ps1", ".bat", ".sol", ".step", ".stp"
]);

function shouldSkipFile(name) {
  return name === "TASK.md" || name === "manifest.json" || name.startsWith(".orchestra-");
}

function looksText(buffer) {
  if (buffer.includes(0)) return false;
  return true;
}

export class Workspace {
  constructor(root) {
    this.root = path.resolve(root);
    this.tasksDir = path.join(this.root, "workspace", "tasks");
    this.artifactsDir = path.join(this.root, "artifacts");
    ensureDir(this.tasksDir);
    ensureDir(this.artifactsDir);
  }

  taskDir(taskId) {
    return safeJoin(this.tasksDir, taskId);
  }

  artifactTaskDir(taskId) {
    return safeJoin(this.artifactsDir, taskId);
  }

  prepareTask(task) {
    const dir = this.taskDir(task.id);
    fs.rmSync(dir, { recursive: true, force: true });
    ensureDir(dir);
    return dir;
  }

  writePrompt(task, prompt) {
    const dir = this.taskDir(task.id);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, "TASK.md"), prompt, "utf8");
    return path.join(dir, "TASK.md");
  }

  reviewDir(taskId, attempt) {
    const dir = safeJoin(this.root, "workspace", "reviews", taskId, `attempt-${attempt}`);
    fs.rmSync(dir, { recursive: true, force: true });
    ensureDir(dir);
    return dir;
  }

  scanTaskDir(taskId) {
    const root = this.taskDir(taskId);
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".orchestra")) continue;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(absolute);
          continue;
        }
        if (!entry.isFile() || shouldSkipFile(entry.name)) continue;
        const stat = fs.statSync(absolute);
        if (stat.size > 1_500_000) continue;
        const buffer = fs.readFileSync(absolute);
        if (!looksText(buffer)) continue;
        const rel = path.relative(root, absolute).replaceAll("\\", "/");
        files.push({ path: rel, content: buffer.toString("utf8"), bytes: stat.size });
      }
    };
    walk(root);
    return files;
  }

  persistArtifacts(taskId, attempt, artifacts, { simulated = false } = {}) {
    const unique = new Map();
    for (const artifact of artifacts ?? []) {
      const rel = sanitizeRelativePath(artifact.path ?? artifact.name);
      unique.set(rel, { ...artifact, path: rel });
    }
    if (!unique.size) return [];
    const attemptDir = safeJoin(this.artifactTaskDir(taskId), `attempt-${attempt}`);
    const latestDir = safeJoin(this.artifactTaskDir(taskId), "latest");
    ensureDir(attemptDir);
    ensureDir(latestDir);
    const descriptors = [];
    for (const artifact of unique.values()) {
      const content = String(artifact.content ?? "");
      const targetAttempt = safeJoin(attemptDir, artifact.path);
      const targetLatest = safeJoin(latestDir, artifact.path);
      ensureDir(path.dirname(targetAttempt));
      ensureDir(path.dirname(targetLatest));
      fs.writeFileSync(targetAttempt, content, "utf8");
      fs.writeFileSync(targetLatest, content, "utf8");
      descriptors.push({
        name: path.basename(artifact.path),
        path: artifact.path,
        attemptPath: `attempt-${attempt}/${artifact.path}`,
        latestPath: `latest/${artifact.path}`,
        sha256: sha256(content),
        bytes: Buffer.byteLength(content),
        attempt,
        source: artifact.source ?? "provider",
        simulated
      });
    }
    this.updateManifest(taskId, attempt, descriptors);
    return descriptors;
  }

  updateManifest(taskId, attempt, descriptors) {
    const file = safeJoin(this.artifactTaskDir(taskId), "manifest.json");
    const manifest = readJson(file, { taskId, versions: [] });
    manifest.updatedAt = nowIso();
    manifest.versions ??= [];
    manifest.versions.push({ attempt, createdAt: nowIso(), artifacts: descriptors });
    if (manifest.versions.length > 100) manifest.versions.splice(0, manifest.versions.length - 100);
    manifest.latest = descriptors;
    atomicWriteJson(file, manifest);
    return manifest;
  }

  readArtifact(taskId, relativePath) {
    const target = safeJoin(this.artifactTaskDir(taskId), relativePath);
    return fs.readFileSync(target, "utf8");
  }

  listLatestArtifacts(taskId) {
    const latest = safeJoin(this.artifactTaskDir(taskId), "latest");
    if (!fs.existsSync(latest)) return [];
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (entry.isFile()) {
          const rel = path.relative(latest, absolute).replaceAll("\\", "/");
          const content = fs.readFileSync(absolute);
          if (looksText(content)) files.push({ path: rel, content: content.toString("utf8") });
        }
      }
    };
    walk(latest);
    return files;
  }

  artifactText(taskId) {
    return this.listLatestArtifacts(taskId).map((file) => `\n--- ${file.path} ---\n${file.content}`).join("\n");
  }

  clearTaskArtifacts(taskId) {
    fs.rmSync(this.artifactTaskDir(taskId), { recursive: true, force: true });
  }
}
