# Architecture

## Goals

- Make the cheapest adequate model safe to use.
- Make long work resumable and auditable.
- Keep L0 decisions and final acceptance with the main model/human.
- Prevent concurrent writers on shared resources.
- Never confuse simulated output with engineering evidence.

## Data flow

```text
plan.json
  │ validate: ids, deps, cycles, depth, task count
  ▼
Store (.orchestra/state.json + journal.jsonl)
  │
  ├─ settle(): deps → ready / blocked / decomposed / human gate
  ├─ route(): privacy, budget, context, quality bar → candidates → score
  ├─ acquireLocks(resources)
  ├─ buildContext(): task + deps + clearance-filtered notes
  ├─ provider.run()
  ├─ persistArtifacts(attempt-N + latest)
  ├─ evaluateDeterministic()
  ├─ reviewWithModel() when critical/all
  ├─ combineGate()
  ├─ retry / escalate / wait / fail / done
  └─ releaseLocks()
```

Every transition is saved before the next external call. A crash can lose an in-flight attempt, not accepted state.

## Modules

| File | Responsibility |
| --- | --- |
| `src/config.js` | Config loading, model normalization, environment expansion, discovery merge |
| `src/domain.js` | Policy/task normalization, DAG validation, depth, progress, labels |
| `src/store.js` | Atomic state, journal, locks, attempts, notes, budgets, model stats |
| `src/router.js` | Eligibility, score, budget/privacy reasons, reviewer selection |
| `src/registry.js` | Role weights, capability fit, thresholds, token/cost estimates |
| `src/context.js` | Context packets, memory index, review prompt, secret/private redaction |
| `src/quality.js` | Deterministic checks, review parsing, gate combination |
| `src/workspace.js` | Isolated task dirs, artifact scanning/versioning, review dirs |
| `src/scheduler.js` | Run loop, decomposition, locks, providers, review, approvals, resume |
| `src/providers/mock.js` | Offline deterministic simulation, always labelled |
| `src/providers/cli.js` | OpenCode/Codex-style CLI subprocess adapter |
| `src/providers/openai.js` | OpenAI-compatible HTTP adapter + `/models` discovery |
| `src/dashboard.js` | Loopback HTTP API + console |
| `src/dashboard.html` | Dashboard UI (no build step) |
| `src/mcp.js` | Newline-delimited JSON-RPC MCP server |
| `src/cli.js` | Operator CLI |
| `src/eval.js` | Routing/quality regression scenarios |

## State model

`state.json` contains:

- `policy`: slider, budget, concurrency, depth/children, review mode, hard flags
- `tasks`: normalized tasks, attempts, route, result, review, approval, artifacts
- `attempts`: execution/review attempts with model, cost, tokens, duration, simulated flag
- `events`: recent event ring (full history in `journal.jsonl`)
- `notes`: shared memory with tags, clearance, source
- `locks`: resource → task lease with expiry
- `modelStats`: runs, successes, quality sum, cost, tokens
- `budget`: API spent/reserved, subscription tokens, free/paid run counts
- `mainModelQuota`: `{status:"unknown", reason}`
- `run`: last run status/stop reason/summary

Task statuses: `pending`, `ready`, `running`, `done`, `failed`, `blocked`, `cancelled`, `waiting_approval`, `waiting_budget`, `needs_main_model`, `decomposed`.

## Routing details

Hard filters:

1. available and provider allowlist
2. privacy rank ≥ task confidentiality + 1
3. unknown privacy/cost rejected by default
4. `zeroExtraPaid` rejects API
5. API estimate ≤ spent/reserved budget
6. estimated tokens ≤ 82% of context
7. capability fit ≥ threshold

Scoring only runs on survivors:

```text
quality = weighted capability − (difficulty−1)×7
costScore: free 100, local 94, subscription 82, API 100 − budget share − absolute penalty
score = q×quality + (1−q)×costScore + history − latency
```

History is a small ±4 adjustment from observed success, not a replacement for capability. Ties favor quality when `q ≥ 0.5`, otherwise cost.

## Review

Critical tasks (`reviewMode=critical`) are reviewed by a **different model**, preferring a different provider. If no cross-provider reviewer exists, fallback is same-provider/different-model and is recorded. If no reviewer exists, the task goes to `waiting_approval`; it is not silently accepted. `skipModelReview` avoids recursive review on review tasks.

## Decomposition

`autoDecompose` with `decomposeInto` creates:

- child tasks at `depth+1`, inheriting confidentiality/group/deps
- one integration task at `depth+1`
- rewires every existing dependent from the parent to the integration task
- marks the parent `decomposed` (excluded from progress denominator)

Limits: `maxDepth`, `maxChildren`, `maxTasks`. If a limit is hit, the parent executes normally instead.

## Persistence choice

V1 uses an atomic JSON snapshot + JSONL journal because:

- the target machine has no Python and no native build toolchain for `better-sqlite3`;
- state fits comfortably in memory for one local scheduler;
- operators can inspect state and journal without tools.

The store interface is isolated. V2 can add SQLite without changing domain/router/scheduler semantics. Single-process ownership is required; do not point two schedulers at one root.

## Deliberately out of scope for V1

- distributed workers
- multi-user auth
- Docker/OS sandboxing
- semantic memory
- CAD kernel automation
- arbitrary web-chat control
- real subscription quota API
