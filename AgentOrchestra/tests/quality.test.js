import assert from "node:assert/strict";
import test from "node:test";
import { normalizePolicy, normalizeTask } from "../src/domain.js";
import { combineGate, evaluateDeterministic, parseReviewOutput } from "../src/quality.js";

const policy = normalizePolicy({ minTaskScore: 60, minReviewScore: 70 });

function makeTask(overrides = {}) {
  return normalizeTask({
    id: "q",
    title: "Quality",
    brief: "Quality fixture",
    kind: "doc",
    role: "documenter",
    difficulty: 2,
    acceptance: {
      minChars: 60,
      mustContain: ["ok"],
      artifacts: ["out.md"],
      requireEvidence: true
    },
    ...overrides
  }, { policy });
}

test("an unverified success claim fails even when the text is long", () => {
  const task = makeTask();
  const result = {
    output: "All tests passed. ok. This is a long enough sentence to satisfy the minimum character requirement for the fixture.",
    artifacts: [{ name: "out.md", path: "out.md", content: "ok" }],
    meta: { simulated: false }
  };
  const gate = evaluateDeterministic(task, result, policy);
  assert.equal(gate.pass, false);
  assert.ok(gate.checks.some((check) => check.id === "no_unverified_claim" && !check.ok));
});

test("a claim backed by explicit command evidence passes", () => {
  const task = makeTask();
  const result = {
    output: [
      "The fixture is ok and long enough to pass the minimum character requirement.",
      "## Evidence",
      "- Evidence class: real",
      "- Command: node check.js",
      "- Output: ok"
    ].join("\n"),
    artifacts: [{ name: "out.md", path: "out.md", content: "ok fixture" }],
    meta: { simulated: false }
  };
  const gate = evaluateDeterministic(task, result, policy);
  assert.equal(gate.pass, true);
  assert.equal(gate.evidenceClass, "real");
});

test("nested artifact paths satisfy a basename expectation", () => {
  const task = makeTask({ acceptance: { minChars: 10, mustContain: ["ok"], artifacts: ["out.md"] } });
  const result = {
    output: "ok",
    artifacts: [{ name: "out.md", path: "docs/out.md", content: "ok" }],
    meta: { simulated: false }
  };
  const gate = evaluateDeterministic(task, result, policy);
  assert.equal(gate.checks.find((check) => check.id === "artifact:out.md").ok, true);
});

test("review JSON parser rejects incomplete verdicts", () => {
  assert.equal(parseReviewOutput("not json").valid, false);
  assert.equal(parseReviewOutput('{"score": 80}').valid, false);
  const parsed = parseReviewOutput('{"score": 82, "pass": true, "issues": []}');
  assert.equal(parsed.valid, true);
  assert.equal(parsed.score, 82);
});

test("critical tasks with no reviewer require human review instead of passing", () => {
  const task = makeTask({
    difficulty: 5,
    acceptance: { minChars: 20, mustContain: ["ok"], artifacts: ["out.md"], critical: true }
  });
  const deterministic = { score: 100, pass: true, hardFail: false, checks: [], issues: [], evidenceClass: "real" };
  const gate = combineGate({ task, deterministic, review: null, reviewRequired: true, policy });
  assert.equal(gate.pass, false);
  assert.equal(gate.status, "needs_human_review");
});
