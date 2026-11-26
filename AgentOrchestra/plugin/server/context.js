import { privacyRank } from "./registry.js";
import { redactSecrets, truncate } from "./util.js";

function section(title, body) {
  return `## ${title}\n${body}\n`;
}

function acceptanceText(acceptance) {
  const rows = [
    `- Minimum characters: ${acceptance.minChars}`,
    acceptance.mustContain.length ? `- Must contain: ${acceptance.mustContain.join(" / ")}` : null,
    acceptance.mustNotContain.length ? `- Must not contain: ${acceptance.mustNotContain.join(" / ")}` : null,
    acceptance.artifacts.length ? `- Required artifacts: ${acceptance.artifacts.join(", ")}` : null,
    acceptance.jsonKeys.length ? `- Required JSON keys: ${acceptance.jsonKeys.join(", ")}` : null,
    acceptance.requireCodeBlock ? "- Must include a fenced code block" : null,
    acceptance.requireEvidence ? "- Must include an Evidence section with command/output or an explicit 'not run'" : null,
    acceptance.requireJsonVerdict ? "- Must include a JSON verdict with numeric score and boolean pass" : null
  ].filter(Boolean);
  return rows.join("\n") || "- No extra structural checks.";
}

export function buildContext({
  task,
  state,
  model,
  route,
  deps = [],
  roles = {},
  promptBudgetChars = null
}) {
  const redactions = [];
  const maxChars = promptBudgetChars ?? Math.min(120000, Math.max(16000, Number(model.contextTokens ?? 128000) * 2.2));
  const noteLimit = 6;
  const relevantNotes = (state.notes ?? [])
    .filter((note) => Number(note.clearance ?? 0) <= Number(task.confidentiality ?? 0))
    .filter((note) => !task.contextTags?.length || note.tags?.some((tag) => task.contextTags.includes(tag)))
    .slice(-noteLimit);

  const noteIndex = relevantNotes.map((note) => `- ${note.id} [${note.tags.join(", ") || "untagged"}] ${truncate(note.text.replace(/\s+/g, " "), 90)}`).join("\n");
  const noteDetails = relevantNotes.map((note) => `### ${note.id} (clearance ${note.clearance})\n${redactSecrets(truncate(note.text, 900))}`).join("\n\n");

  const depSections = deps.map((dep) => {
    const artifacts = (dep.result?.artifacts ?? []).map((artifact) => artifact.latestPath ?? artifact.path).join(", ");
    const summary = dep.result?.summary || dep.result?.output || "(no result)";
    return `### ${dep.id} — ${dep.title}\nStatus: ${dep.status}\nArtifacts: ${artifacts || "none"}\n${truncate(redactSecrets(summary), 1400)}`;
  }).join("\n\n");

  const hardRules = [
    "Work only on the assigned task and inside the provided working directory.",
    "Do not claim a command, test, build, CAD operation, or review was run unless you actually ran it in this session.",
    "If something is unverified, write 'not run' or 'unknown' explicitly. Never turn a guess into evidence.",
    "Never copy secrets, API keys, personal data, or <private> blocks into your output.",
    `Data boundary: this task has confidentiality level ${task.confidentiality} (0 public, 1 internal, 2 confidential). The selected model boundary is "${model.privacy}" (rank ${privacyRank(model.privacy)}).`,
    "Required artifacts must be written as real files in the current directory, or as fenced blocks labelled ```artifact path=relative/path.",
    "End with a concise summary, evidence class (real or simulated), commands actually run, and residual risks."
  ].join("\n");

  const projectDescription = state.projectDescription ? `\n${state.projectDescription}` : "";
  const prompt = [
    "# AgentOrchestra Worker Contract",
    hardRules,
    "",
    section("Project", `${state.project}${projectDescription}`),
    section("Task", [
      `ID: ${task.id}`,
      `Title: ${task.title}`,
      `Group: ${task.group}`,
      `Kind: ${task.kind}`,
      `Tier: ${task.tier}`,
      `Role: ${task.role}`,
      `Difficulty: ${task.difficulty}/5`,
      `Priority: ${task.priority}`,
      `Resources: ${task.resources.length ? task.resources.join(", ") : "none"}`,
      "",
      task.brief || "(no brief)"
    ].join("\n")),
    section("Acceptance criteria", acceptanceText(task.acceptance)),
    depSections ? section("Dependency context", depSections) : "",
    noteIndex ? section("Project memory index", `${noteIndex}\n\n${noteDetails}`) : "",
    section("Routing context", [
      `Selected model: ${model.id} (${model.label})`,
      `Provider: ${model.provider}; cost class: ${model.costClass}; privacy: ${model.privacy}`,
      `Fitted quality: ${route?.selected?.quality ?? "n/a"}; minimum bar: ${route?.minQuality ?? "n/a"}`,
      `Quality preference: ${state.policy.qualityPreference}/100 (this does not lower acceptance)`
    ].join("\n")),
    section("Output contract", [
      "- Put the final answer in text.",
      "- Write every required artifact. For HTTP providers use exactly:",
      "  ```artifact path=relative/path",
      "  file content",
      "  ```",
      "- Do not wrap the whole answer in one artifact block.",
      "- State evidence class as real or simulated. Mock/simulated output must say so."
    ].join("\n"))
  ].filter(Boolean).join("\n");

  let finalPrompt = truncate(redactSecrets(prompt), maxChars);
  if (finalPrompt.includes("[REDACTED")) redactions.push("private-or-secret-pattern");
  return {
    prompt: finalPrompt,
    chars: finalPrompt.length,
    redactions,
    includedNotes: relevantNotes.map((note) => note.id),
    includedDeps: deps.map((dep) => dep.id),
    promptBudgetChars: maxChars
  };
}

export function buildReviewPrompt({ task, result, deterministic, minReviewScore, reviewerModel }) {
  const checks = (deterministic.checks ?? []).map((check) => `- ${check.ok ? "PASS" : "FAIL"} ${check.id}: ${check.detail}`).join("\n");
  const artifacts = (result.artifacts ?? []).map((artifact) => `- ${artifact.latestPath ?? artifact.path} (${artifact.bytes ?? "?"} bytes)`).join("\n");
  return [
    "# Independent Review Contract",
    "You are a reviewer from a different model/provider than the producer when possible.",
    "Do not rewrite the work. Judge it against the acceptance criteria.",
    "Do not claim you ran tests, opened CAD, or inspected files you were not given.",
    "If evidence is simulated, missing, or only structural, say so and do not pass it as real engineering evidence.",
    `Review model: ${reviewerModel?.id ?? "unknown"}`,
    "",
    `## Task\n${task.id} — ${task.title}\n${task.brief}`,
    "",
    "## Acceptance criteria",
    acceptanceText(task.acceptance),
    "",
    "## Deterministic checks",
    checks || "(none)",
    "",
    "## Produced artifacts",
    artifacts || "(none)",
    "",
    "## Producer output",
    truncate(redactSecrets(result.output ?? ""), 12000),
    "",
    "Return ONLY a JSON object with this shape:",
    "{\"score\": 0-100, \"pass\": true|false, \"issues\": [\"...\"], \"residual_risks\": [\"...\"]}",
    `Pass only if the work clears the review bar of ${minReviewScore} and the evidence is adequate for the task's confidentiality.`
  ].join("\n");
}
