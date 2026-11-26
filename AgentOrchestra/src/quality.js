import { parseJsonLoose, tail } from "./util.js";

const UNVERIFIED_CLAIMS = [
  /\b(tests? (?:passed|pass)|all tests pass|build (?:passed|succeeded)|verified successfully)\b/i,
  /(测试通过|全部测试通过|验证通过|已通过验证|构建成功)/
];

function check(id, ok, detail, weight = 10, hard = true) {
  return { id, ok: Boolean(ok), detail, weight, hard };
}

function collectText(result) {
  const artifactText = (result.artifacts ?? []).map((artifact) => artifact.content ?? "").join("\n");
  return `${result.output ?? ""}\n${artifactText}`;
}

function artifactNames(result) {
  return new Set((result.artifacts ?? []).flatMap((artifact) => [
    String(artifact.name ?? ""),
    String(artifact.path ?? ""),
    String(artifact.latestPath ?? "")
  ]).filter(Boolean));
}

function hasArtifact(result, expected) {
  const normalized = String(expected).replaceAll("\\", "/");
  const base = normalized.split("/").pop();
  const names = artifactNames(result);
  for (const name of names) {
    const candidate = name.replaceAll("\\", "/");
    if (candidate === normalized) return true;
    if (candidate.endsWith(`/${normalized}`)) return true;
    if (!normalized.includes("/") && candidate.split("/").pop() === base) return true;
  }
  return false;
}

function collectJsonObjects(result) {
  const objects = [];
  const outputObject = parseJsonLoose(result.output);
  if (outputObject && typeof outputObject === "object") objects.push(outputObject);
  for (const artifact of result.artifacts ?? []) {
    if (typeof artifact.content !== "string") continue;
    const parsed = parseJsonLoose(artifact.content);
    if (parsed && typeof parsed === "object") objects.push(parsed);
  }
  return objects;
}

export function evaluateDeterministic(task, result, policy) {
  const checks = [];
  const text = collectText(result);
  const output = String(result.output ?? "");
  const minChars = Number(task.acceptance?.minChars ?? 0);
  const hasText = text.trim().length > 0;
  checks.push(check("non_empty", hasText, hasText ? "Output or artifacts are present" : "No output or artifacts", 60));
  if (minChars > 0) {
    checks.push(check("min_chars", text.length >= minChars, `${text.length} chars; required ${minChars}`, 30));
  }
  for (const term of task.acceptance?.mustContain ?? []) {
    const ok = text.toLowerCase().includes(term.toLowerCase());
    checks.push(check(`must_contain:${term}`, ok, ok ? `Found ${term}` : `Missing required term: ${term}`, 12));
  }
  for (const term of task.acceptance?.mustNotContain ?? []) {
    const ok = !text.toLowerCase().includes(term.toLowerCase());
    checks.push(check(`must_not_contain:${term}`, ok, ok ? `Forbidden term absent: ${term}` : `Forbidden term present: ${term}`, 25));
  }
  for (const expected of task.acceptance?.artifacts ?? []) {
    const ok = hasArtifact(result, expected);
    checks.push(check(`artifact:${expected}`, ok, ok ? `Artifact present: ${expected}` : `Missing artifact: ${expected}`, 25));
  }
  if (task.acceptance?.requireCodeBlock) {
    const ok = /```[\s\S]*?```/.test(text);
    checks.push(check("code_block", ok, ok ? "Fenced code block found" : "No fenced code block", 20));
  }
  const claim = UNVERIFIED_CLAIMS.map((pattern) => text.match(pattern)?.[0]).find(Boolean);
  if (claim) {
    const simulated = Boolean(result.meta?.simulated);
    const hasRealEvidence = /(evidence class\s*:\s*real|command\s*:|exit code|sha256)/i.test(text) && !simulated;
    checks.push(check("no_unverified_claim", hasRealEvidence, hasRealEvidence ? `Claim backed by evidence: ${claim}` : `Unverified success claim: "${claim}"`, 40));
  }
  if (task.acceptance?.requireEvidence) {
    const hasEvidenceSection = /(^|\n)#{1,4}\s*(Evidence|证据)/i.test(text);
    const hasEvidenceDetail = /(evidence class|command|output|sha256|artifact|not run|未运行|未执行|simulation|模拟)/i.test(text);
    checks.push(check("evidence_section", hasEvidenceSection && hasEvidenceDetail, hasEvidenceSection && hasEvidenceDetail ? "Evidence section found" : "Missing a concrete evidence section", 25));
  }
  if (task.acceptance?.jsonKeys?.length) {
    const objects = collectJsonObjects(result);
    const best = objects
      .filter((object) => object && typeof object === "object" && !Array.isArray(object))
      .sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0];
    const missing = task.acceptance.jsonKeys.filter((key) => !best || !(key in best));
    checks.push(check("json_keys", Boolean(best) && missing.length === 0, best ? (missing.length ? `Missing JSON keys: ${missing.join(", ")}` : "All JSON keys present") : "No JSON object found", 25));
  }
  if (task.acceptance?.requireJsonVerdict) {
    const objects = collectJsonObjects(result);
    const verdict = objects.find((object) => object && typeof object === "object" && typeof object.score === "number" && typeof object.pass === "boolean");
    checks.push(check("json_verdict", Boolean(verdict), verdict ? `Verdict score=${verdict.score} pass=${verdict.pass}` : "Missing {score:number, pass:boolean} verdict", 30));
  }

  let score = 100;
  let hardFail = false;
  for (const item of checks) {
    if (!item.ok) {
      score -= item.weight;
      if (item.hard) hardFail = true;
    }
  }
  score = Math.max(0, Math.min(100, score));
  const pass = !hardFail && score >= Number(policy.minTaskScore ?? 60);
  return {
    score,
    pass,
    hardFail,
    checks,
    issues: checks.filter((item) => !item.ok).map((item) => item.detail),
    evidenceClass: result.meta?.simulated ? "simulated" : "real",
    textChars: text.length
  };
}

export function parseReviewOutput(output) {
  const parsed = parseJsonLoose(output);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, reason: "Reviewer did not return a JSON object", raw: tail(output, 1200) };
  }
  const score = Number(parsed.score);
  if (!Number.isFinite(score) || typeof parsed.pass !== "boolean") {
    return { valid: false, reason: "Reviewer JSON must contain numeric score and boolean pass", raw: tail(output, 1200) };
  }
  return {
    valid: true,
    score: Math.max(0, Math.min(100, score)),
    pass: parsed.pass,
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
    residualRisks: Array.isArray(parsed.residual_risks) ? parsed.residual_risks.map(String) : [],
    simulated: Boolean(parsed.simulated),
    raw: parsed
  };
}

export function combineGate({ task, deterministic, review, reviewRequired, policy }) {
  const base = {
    deterministicScore: deterministic.score,
    deterministicPass: deterministic.pass,
    checks: deterministic.checks,
    issues: [...deterministic.issues],
    review,
    reviewRequired,
    evidenceClass: deterministic.evidenceClass
  };
  if (!deterministic.pass) {
    return { ...base, pass: false, score: deterministic.score, status: "rejected", reason: "Deterministic acceptance checks failed" };
  }
  if (!reviewRequired) {
    const score = deterministic.score;
    return {
      ...base,
      pass: score >= Number(policy.minTaskScore ?? 60),
      score,
      status: score >= Number(policy.minTaskScore ?? 60) ? "accepted" : "rejected",
      reason: "Deterministic gate only"
    };
  }
  if (!review) {
    return {
      ...base,
      pass: false,
      score: deterministic.score,
      status: "needs_human_review",
      reason: "Critical task requires an independent review, but no reviewer result is available"
    };
  }
  if (review.valid === false) {
    return {
      ...base,
      pass: false,
      score: deterministic.score,
      status: "needs_human_review",
      reason: review.reason ?? "Invalid reviewer output",
      issues: [...base.issues, review.reason ?? "Invalid reviewer output"]
    };
  }
  const score = Math.round((deterministic.score * 0.4 + review.score * 0.6) * 10) / 10;
  const pass = deterministic.pass && review.pass && score >= Number(policy.minReviewScore ?? 70);
  return {
    ...base,
    pass,
    score,
    status: pass ? "accepted" : "rejected",
    reason: pass ? "Deterministic + independent review passed" : "Independent review or combined score did not clear the bar",
    issues: [...base.issues, ...(review.issues ?? [])]
  };
}

export function isCriticalTask(task, policy) {
  if (policy.reviewMode === "off") return false;
  if (task.acceptance?.skipModelReview) return false;
  if (policy.reviewMode === "all") return true;
  return Boolean(task.acceptance?.critical) || task.difficulty >= 4 || task.confidentiality >= 2 || task.kind === "review";
}
