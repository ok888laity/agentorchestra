---
name: AgentOrchestra
description: Cost-aware, verification-driven multi-model orchestration for long, multi-module work. Use when a task needs DAG decomposition, free/paid model routing, budgets, privacy boundaries, independent review, human gates, single-writer resource locks, or resumable execution across Codex, OpenCode and OpenAI-compatible providers.
metadata:
  opencode/autoinvoke: true
---

# AgentOrchestra

AgentOrchestra is the **entry and rule layer** for long-running, multi-module work. The deterministic scheduler underneath owns task state, routing, budgets, locks and evidence. Do not turn this into a chat room of agents.

The main model stays responsible for L0 decisions: understanding the request, architecture, acceptance standards and final human-facing judgement. Workers do bounded L1/L2 work. The scheduler never silently accepts a lower-quality result just because a cheaper model was selected.

## Hard rules

1. **L0 stays with the main model.** Do not delegate final architecture, safety, patent or engineering release decisions to an L2 worker. Use `owner: "main"` or a human gate.
2. **No unverified completion claims.** “Tests passed”, “verified”, “build succeeded” are only valid with the command and output that were actually observed. Mock output must say `simulated`. `complete`/MCP completion still goes through the deterministic gate.
3. **Privacy is a hard boundary.** Confidentiality levels: `0` public, `1` internal, `2` confidential. Required model boundary: public → trusted → local. Never send confidential text, full engineering drawings or unpublished patent material to a public/unknown endpoint. Free does not mean safe.
4. **Budget is a hard stop, not a suggestion.** Default is strict zero-extra-paid. If no adequate model fits the budget, the task waits (`waiting_budget`) or asks for authorisation. Never lower the acceptance threshold to make a cheap model pass.
5. **One writer per resource.** SolidWorks assemblies, shared repositories and any file that cannot be merged safely must use a resource lock such as `solidworks:assembly`. Parallel read/design/review is fine; concurrent writes are not.
6. **Do not invent quota.** GPT/Claude subscription remaining quota is not exposed by a stable public API in this build. Report `unknown`, not a number.
7. **Do not spawn infinite agents.** Defaults: max depth 2, max 6 children per task, max concurrency 3. More agents can cost more than they save.

## What is real today

- Deterministic scheduler, DAG, budgets, privacy routing, quality gates, review, resource locks, artifacts/versioning, resume, MCP server: implemented and covered by tests.
- `mock` provider: deterministic offline simulation. It proves orchestration only. It is **not** engineering evidence.
- OpenCode/Codex CLI and OpenAI-compatible HTTP adapters: implemented as templates. Verify flags and credentials before relying on them. They were not exercised on this machine (no CLI/key).
- SolidWorks: only the single-writer lock and task contract exist. There is no CAD kernel integration in V1.

## Plugin mode

If AgentOrchestra is installed as a plugin, prefer the host integration:

- **OpenCode**: the plugin auto-registers the `agentorchestra` MCP server, the skill, `/orchestra-status`, `/orchestra-run` and `/orchestra-models`. It refreshes the host model catalogue on setup and before each prompt.
- **Codex**: install the bundle from `.agents/plugins/marketplace.json`; use the bundled MCP tools, the `agentorchestra` skill and `orchestra_sync_models` for host models. Codex does not expose a stable subscription model-list API to plugins.

**First-run provider choices:** future users must run `orchestra_classify_host_models` / `/orchestra-models`, review evidence and confidence, then confirm each provider with `orchestra_set_provider_policy`. Confirmed choices are written to the user's `.orchestra/host-policy.json`. The plugin's shipped `config/host-policy.json` is intentionally neutral/disabled; never bake one user's billing or privacy choice into the plugin defaults.
- **Standalone**: run the CLI from `AgentOrchestra/` as shown below.

The plugin bundle is generated at `AgentOrchestra/plugin/`; see `docs/PLUGIN_INSTALL.md`. Do not edit the installed plugin cache for persistent policy; use the MCP tools or a project-local root.

## Standard workflow

Use the bundled MCP tools by default. If you need the CLI, run from the plugin root:

```bash
node server/cli-plugin.js doctor
node server/cli-plugin.js demo --reset          # offline proof of the whole pipeline
node server/cli-plugin.js status
```

For real work:

```bash
# 1. Validate/install a DAG
node server/cli-plugin.js plan --file examples/subsea-rig.json

# 2. Inspect routing before spending anything
node server/cli-plugin.js route --task flow-design --quality 40

# 3. Execute, then inspect evidence
node server/cli-plugin.js run --max-steps 100
node server/cli-plugin.js status

# 4. Human gate
node server/cli-plugin.js approve approval --note "reviewed drawings and residual risks"

# 5. Long-running console
```

The CLI is resumable. A crash or restart does not erase accepted work. Start again with `run`; locks left by interrupted tasks are recovered.

## Plan contract

A plan is data, not prose. Every task needs an explicit brief and acceptance criteria.

```json
{
  "project": "my-project",
  "policy": {
    "qualityPreference": 45,
    "apiBudgetCny": 0,
    "zeroExtraPaid": true,
    "maxConcurrency": 3,
    "maxDepth": 2,
    "reviewMode": "critical"
  },
  "tasks": [
    {
      "id": "research",
      "title": "Collect evidence",
      "brief": "What to find, what is out of scope, how to treat uncertainty.",
      "group": "Research",
      "kind": "research",
      "tier": "L2",
      "role": "researcher",
      "difficulty": 2,
      "confidentiality": 0,
      "deps": [],
      "acceptance": {
        "minChars": 500,
        "mustContain": ["evidence", "unknowns"],
        "artifacts": ["research.md"],
        "requireEvidence": true
      }
    },
    {
      "id": "design",
      "title": "Design the solution",
      "brief": "Interfaces, failure modes, risks and the simplest adequate design.",
      "group": "Design",
      "kind": "design",
      "tier": "L1",
      "role": "designer",
      "difficulty": 4,
      "confidentiality": 1,
      "deps": ["research"],
      "acceptance": {
        "minChars": 400,
        "mustContain": ["interface", "failure", "risk"],
        "artifacts": ["design.md"],
        "requireEvidence": true,
        "critical": true
      }
    },
    {
      "id": "approval",
      "title": "Human acceptance",
      "brief": "A human must decide. The model cannot self-approve.",
      "tier": "L0",
      "kind": "approval",
      "group": "Acceptance",
      "deps": ["design"],
      "humanGate": true,
      "acceptance": { "minChars": 0 }
    }
  ]
}
```

Useful node types:

| Type | Behaviour |
| --- | --- |
| `research`, `design`, `code`, `doc`, `modeling`, `analysis` | Routed model task with evidence gate |
| `review` | Produces a JSON verdict; use `skipModelReview: true` to avoid recursive review |
| `script` | Deterministic command with an executable allowlist; real evidence, no model |
| `approval` / `humanGate: true` | Waits for a human; never auto-approved |
| `autoDecompose` + `decomposeInto` | Creates children + an integration node, then rewires dependents |

## Model pool, billing and pins

The product is one brain plus a bounded worker pool, not a catalogue of every model.

- `billingMode: "subscription"` (default): free/local/subscription are allowed; API-metered models are rejected. `free-first` also rejects API. `allow-api` requires an explicit budget.
- `poolSize: "auto"` uses `maxConcurrency`; if review is enabled, the pool planner reserves a reviewer slot.
- `pins` fixes a model by role, task, or all work. A pinned model must still pass privacy, budget and the quality bar. If it does not, the task fails with `pin_ineligible`; the router must not silently substitute another model.
- `orchestra_plan_pool` / `node server/cli-plugin.js pool` shows target slots, usable slots, shortages, free share and estimated cost per wave.

Example:

```json
{
  "billingMode": "subscription",
  "poolSize": "auto",
  "pins": {
    "all": null,
    "roles": { "reviewer": "provider/reviewer-model" },
    "tasks": { "flow-design": "provider/design-model" }
  }
}
```

The main brain model is not cheap-routed. Only worker/delegation calls are routed.

### Host model sync

- OpenCode: the plugin reads `ctx.model.list()` on setup and on each prompt, writing `host-models.json`. `/orchestra-models` refreshes it and opens the pool view. Host models default to `billing=unknown`, `privacy=unknown`; confirm them in plugin options or they stay excluded.
- Codex: call `orchestra_sync_models` with the available models and explicit billing/privacy. Codex does not expose a stable subscription model-list API to plugins; do not pretend it auto-enumerates when it cannot.

## Routing

Routing is deterministic and explainable:

```text
quality = role-weighted capability - (difficulty - 1) * 7
threshold = 24 + difficulty * 5 + tier bonus (L1 +8, L0 +18) + critical +4
score = q * quality + (1 - q) * costScore + history - latency
```

- `q = qualityPreference / 100`: 0 is cost-first, 100 is quality-first.
- Adequacy is checked **before** scoring. A cheap model that misses the bar is rejected.
- On failure, the tried model is excluded and the next attempt escalates. If nothing adequate fits, pause; do not lower the bar.
- History updates success rate and average score, but never overrides privacy or budget constraints.
- Route preview includes rejected candidates and reasons. Use it before spending.

## Evidence classes

| Class | Meaning |
| --- | --- |
| `real` | Command/output or file produced by a configured real provider or deterministic script |
| `simulated` | Mock output; never engineering evidence |
| `main_model` | Supplied by the main model; deterministic gate still applies |
| `human-approved` | A human explicitly closed a gate |

Status output shows these classes. A simulated-only run is labelled as such.

## Failure handling

| Situation | Correct action |
| --- | --- |
| Quality gate fails | Retry with an escalated model, then stop after `maxAttempts` |
| Budget exhausted | Leave `waiting_budget`; increase budget or authorise spend |
| Privacy blocks all models | Do not downgrade; use a local/trusted model or reduce scope |
| Reviewer unavailable | `waiting_approval`; human review, not silent acceptance |
| Provider/CLI error | Record the attempt, escalate or fail; never fabricate output |
| Resource lock held | Wait; do not spawn a second writer |
| Run interrupted | Re-run; accepted tasks and artifacts persist |

## MCP tools

If OpenCode/Codex is connected to the local MCP server, prefer tools over shell when available:

- `orchestra_status`
- `orchestra_submit`
- `orchestra_run`
- `orchestra_route_preview`
- `orchestra_approve`
- `orchestra_complete_task`
- `orchestra_set_policy`
- `orchestra_list_models`
- `orchestra_note`
- `orchestra_retry`
- `orchestra_control`
- `orchestra_doctor`
- `orchestra_classify_host_models`
- `orchestra_set_provider_policy`

The plugin bundles the stdio server at `server/launch-mcp.js`. Codex loads it through `mcp.json` / `.mcp.json`; OpenCode registers it through `opencode-server.js`.

## What not to do

- Do not run a swarm of agents without a dependency graph and acceptance criteria.
- Do not ask a model to estimate progress; progress comes from accepted task state.
- Do not let a cheaper model “try again” forever without escalation.
- Do not put API keys, tokens or `<private>` blocks into prompts or artifacts.
- Do not let two workers write the same SolidWorks assembly or shared file.
- Do not claim that a mock demo validates the engineering design.
- Do not claim subscription savings unless a measured run supports it.

## Reference

- `README.md` — quick start, architecture, limits.
- `docs/ARCHITECTURE.md` — components and state model.
- `docs/PRIOR_ART.md` — GitHub projects studied and what was borrowed.
- `docs/SECURITY.md` — threat model and data boundaries.
- `docs/VERIFICATION.md` — what was actually tested, and what was not.
- `docs/ROADMAP.md` — V2/V3 gaps.


## Plugin mode

This is the installable plugin bundle. The MCP server is bundled at `server/launch-mcp.js`; Codex uses the root `mcp.json` / compatibility `.mcp.json`, and OpenCode registers it automatically through `opencode-server.js`.

- Codex state defaults to `PLUGIN_DATA` or `~/.agentorchestra`; configuration falls back to the bundled `config/`.
- OpenCode state is project-scoped by default, or set `options.root` in the plugin entry.
- CLI fallback: `node server/cli-plugin.js status`.
- Do not edit files under the installed plugin cache for persistent policy; use the MCP tools or a project-local root.

