import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const nowIso = () => new Date().toISOString();

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function hashObject(value) {
  return sha256(stableStringify(value));
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = undefined) {
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw new Error(`Cannot read JSON at ${file}: ${error.message}`);
  }
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function atomicWriteJson(file, value) {
  ensureDir(path.dirname(file));
  const json = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  fs.writeFileSync(tmp, json, "utf8");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt === 5) {
        // Last-resort replacement keeps the tool usable on locked Windows files.
        fs.writeFileSync(file, json, "utf8");
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // ignore
        }
        return;
      }
      sleepSync(25 * (attempt + 1));
    }
  }
}

export function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

export function safeJoin(root, ...parts) {
  const rootAbs = path.resolve(root);
  const joined = path.resolve(rootAbs, ...parts);
  const rel = path.relative(rootAbs, joined);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return joined;
  throw new Error(`Unsafe path outside ${rootAbs}: ${parts.join("/")}`);
}

export function sanitizeRelativePath(input) {
  const normalized = String(input).replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) throw new Error("Empty artifact path");
  for (const part of parts) {
    if (part === "." || part === "..") throw new Error(`Unsafe artifact path: ${input}`);
    if (/^[a-zA-Z]:$/.test(part)) throw new Error(`Unsafe artifact path: ${input}`);
  }
  return parts.join("/");
}

export function truncate(text, maxChars = 4000) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return value;
  const head = Math.max(0, maxChars - 240);
  return `${value.slice(0, head)}\n\n[... truncated ${value.length - head} chars ...]\n\n${value.slice(-200)}`;
}

export function parseJsonLoose(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  const candidates = [...fenced, raw];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }
  const firstObject = raw.indexOf("{");
  const lastObject = raw.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    try {
      return JSON.parse(raw.slice(firstObject, lastObject + 1));
    } catch {
      // continue
    }
  }
  const firstArray = raw.indexOf("[");
  const lastArray = raw.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) {
    try {
      return JSON.parse(raw.slice(firstArray, lastArray + 1));
    } catch {
      // continue
    }
  }
  return null;
}

export function expandEnv(value) {
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnv(item)]));
  }
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => process.env[name] ?? "");
}

export function redactSecrets(text) {
  let value = String(text ?? "");
  value = value.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED:private-block]");
  value = value.replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED:api-key]");
  value = value.replace(/\b(gh[pousr]_[A-Za-z0-9]{12,})\b/g, "[REDACTED:github-token]");
  value = value.replace(/\b(AKIA[0-9A-Z]{12,})\b/g, "[REDACTED:aws-key]");
  value = value.replace(/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED:slack-token]");
  value = value.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]");
  return value;
}

export function slugify(input) {
  const slug = String(input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "task";
}

export function shortHash(input, length = 6) {
  return sha256(String(input)).slice(0, length);
}

export function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.map((item) => (item && typeof item === "object" ? deepMerge({}, item) : item));
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const output = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    output[key] = deepMerge(output[key], value);
  }
  return output;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function formatCny(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return "unknown";
  return `¥${number.toFixed(number >= 10 ? 2 : 4)}`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  if (total < 1000) return `${total}ms`;
  if (total < 60000) return `${(total / 1000).toFixed(1)}s`;
  const minutes = Math.floor(total / 60000);
  const seconds = Math.round((total % 60000) / 1000);
  return `${minutes}m${seconds}s`;
}

export function tail(text, maxChars = 4000) {
  const value = String(text ?? "");
  return value.length <= maxChars ? value : `...${value.slice(-maxChars)}`;
}

export function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function percent(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}
