# Verification record

Date: 2026-11-26
Machine: Windows 10.0.26100, Node.js v20.20.2, npm 10.8.2
Workspace: the `AgentOrchestra/` project directory (local absolute path omitted)

## Environment facts

| Tool | Status |
| --- | --- |
| Node.js | available, v20.20.2 |
| npm | available, 10.8.2 |
| Python | **not usable** (Windows Store alias only) |
| git | **not on PATH** |
| `opencode` CLI | **not on PATH** |
| `codex` CLI | **not on PATH** |
| better-sqlite3 | **cannot build** (no Python/native toolchain) |

Consequences:

- Implementation uses zero-dependency Node ESM.
- Persistence uses atomic JSON + JSONL, not SQLite.
- No real Codex→OpenCode call was executed.
- OpenCode/Codex CLI adapters remain templates until smoke-tested.

## Commands actually run

```text
node --test
# 45 tests, 45 pass, 0 fail

node src/cli.js demo --reset
# Installed 8 tasks.
# Run: needs_approval in 413ms (7 steps)
# Progress: 92.6% (7/8 accepted)
# waiting approval: 1
# API spend: ¥0.0000
# simulated results: present; deterministic script result: real

node src/cli.js eval
# 8/8 scenarios pass

node src/cli.js pool
# target 3, usable 3, designer/coder/reviewer slots
# billing=subscription, API cost per wave ¥0
# warns that 117 host-discovered models still have unknown billing/privacy

node src/cli.js status
# 7 done, 1 waiting_approval, no locks held,
# main-model quota = unknown

node src/cli.js route --task design
# selected mock/sub-designer, quality 63.2 / min 56
# rejected reasons include quality_below_bar, zero_extra_paid, unavailable

node src/cli.js doctor
# Node ok; state writable; 14 models;
# mock/mock-audit available; openai baseURL missing;
# opencode/codex commands reported missing after provider probing was broadened
```

Additional real-network verification:

```text
AGENTORCHESTRA_OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
  node src/cli.js models discover --provider openai --root <temp-dir>
# Discovered 474 models; 14 classified free; 460 priced/unknown.
# Written only to the temp root, not the project state.
```

Adapter verification without external accounts:

```text
tests/providers.test.js
# Fake CLI provider: real artifact scanning, real evidence class, exit/output capture.
# Local OpenAI-compatible HTTP server: request shape, artifact block persistence, real evidence.
```

Plugin verification:

```text
node scripts/build-plugin.js
node scripts/verify-plugin.js
# [ok] Codex portable manifest
# [ok] Codex compatibility manifest
# [ok] portable stdio MCP config
# [ok] OpenCode plugin package
# [ok] bundled skill
# [ok] bundled core
# [ok] bundled MCP stdio handshake

AGENTORCHESTRA_ROOT=<temp> PLUGIN_DATA=<temp> \
  node plugin/server/cli-plugin.js demo --reset
# 8 tasks; 7 accepted; final human gate waiting; simulated mock output.
```

OpenCode integration was exercised live:

```text
# ~/.local/share/opencode/log/opencode.log
msg="loading plugin" id=".../AgentOrchestra/plugin"
  entrypoint=file:///.../plugin/opencode-server.js
message="mcp connected" server=agentorchestra tools=17
```

After removing the manual `mcp.servers.agentorchestra` block from `opencode.json` and keeping only the `plugins` entry, `agentorchestra_orchestra_status` still returned the persisted project state. This confirms the OpenCode plugin path is doing the MCP registration, not a leftover manual entry. `orchestra_status` is compact by default to avoid dumping the full event/route history into the main model context; `detail: true` returns everything.

Host model sync was exercised live: OpenCode wrote 117 host models to `.orchestra/host-models.json`. The user then classified the providers explicitly: `opencode` disabled, `opencode-go` common domestic + free models enabled, `openai` paid API. `config/host-policy.json` applies this at load time, so disabled/foreign/unconfirmed groups cannot slip into routing. The remaining 75 `openai` models stay excluded until the user explicitly enables API spend and confirms privacy.

Automatic classification reported three groups with evidence: `openai` = paid API (75 models), `opencode-go` = mixed subscription/free (31 models), `opencode` = free (11 models). Privacy `trusted` was only offered as a candidate because no technical metadata can prove a provider's data policy. The user then chose:

- `opencode-go`: `subscription` / `trusted`
- `openai`: `api` / `unknown`, keep blocked by subscription billing mode
- `opencode`: `free` / `public`

These choices are persisted in this workspace's `.orchestra/host-policy.json` and survive host refreshes. The plugin bundle still ships a neutral `config/host-policy.json` with all providers disabled so future users must classify and choose for themselves.

A real free host model was then executed end-to-end through the OpenCode bridge:

```text
task: host-smoke
model: host:opencode:opencode-go/hungerg-free
result: done
score: 100
evidence: real
simulated: false
duration: 7.1s
tokens: 624 in / 77 out
API spend: ¥0.00
artifact: smoke.md

AGENTORCHESTRA_HOST_OK
```

The `openai` and `opencode` providers were not touched. This is the first real model call in the project, not a mock fixture.

The OpenCode plugin also started a loopback host execution bridge; the catalogue records `executor=host-opencode`, and the MCP child receives the bridge endpoint/token through its environment. Running `orchestra_doctor` through the OpenCode MCP server reported:

```text
host-opencode: available — OpenCode host bridge reachable
```

A host-http fixture test verifies the request/response/artifact path, but no real paid/subscription model was invoked during this verification. The bridge uses `ctx.experimental.generate.text`, so it executes models through the host's existing authentication rather than an extra API key.

Dashboard verification:

```text
GET /api/health -> {"ok":true,...}
GET / -> 200, title "AgentOrchestra Console", no browser console errors
full-page screenshot rendered KPIs, policy slider, groups, tasks, models, events, facts
```

The dashboard's approve button was exercised in the browser: the human gate moved the project from 7/8 to 8/8 and the UI updated to 100.0%. The "run pending" button was not clicked; run behavior is covered by scheduler/MCP tests and HTTP routes.

## What the tests cover

- DAG cycle rejection and depth computation
- Policy normalization/clamping
- Privacy exclusion for confidential tasks
- Public-only pool rejection
- Cost-first vs quality-first selection
- Zero-extra-paid and budget exhaustion
- Minimum acceptance independence from the cost slider
- Unverified success-claim rejection
- Evidence-backed claim acceptance
- Artifact basename/nested path matching
- Review JSON validation and human-review fallback
- JSON state persistence
- Exclusive resource locks and lease expiry
- Artifact versioning and traversal rejection
- Starter run: 7/8 accepted, human gate closed
- Script task produces real `check.json` evidence
- Resume and human approval
- Budget pause and wake-after-budget
- Single-writer resource non-overlap
- Recursive decomposition + dependent rewiring
- Main-model completion gated
- MCP handler tools/submit/run/status/approve
- MCP stdio newline-delimited JSON-RPC
- CLI subprocess adapter with artifact scanning
- OpenAI-compatible HTTP adapter with artifact blocks
- Dual-host plugin bundle manifests and bundled MCP handshake
- Run lock preventing two concurrent scheduler runs
- Billing-mode filtering (subscription/free-first/API)
- Pins by role/all/task and fail-closed ineligible pins
- Pool slot sizing, reviewer reserve, host-model warnings and pin preservation
- Host model sync/merge and one-time billing/privacy confirmation preservation
- Host provider policy (disable opencode, allow common domestic/free opencode-go, API-only openai)
- Host-http execution bridge with artifacts and real evidence
- Real free `opencode-go` model smoke task through the bridge
- Provider classification from catalogue prices, endpoints and Codex auth mode
- User-confirmed provider policy persistence
- Enforced pool restriction for accepted model assignments

## Not verified

1. Paid/subscription domestic models through the host bridge — the free `opencode-go/hungerg-free` model was verified end-to-end, but no paid domestic or premium model was invoked.
2. Codex plugin SessionStart hook — generated with the bundle, but no Codex CLI was available to install and trigger it.
2. Real Codex CLI invocation (`codex exec ...` flags).
3. Actual Codex plugin installation through the Codex CLI plugin browser — no Codex CLI on this machine. Manifests and stdio MCP handshake are validated.
4. Real OpenAI-compatible model call with a live credential.
5. SolidWorks API/COM connection, save/rollback and process lock.
6. Subscription remaining quota (no stable public API).
7. Quality/cost calibration on real tasks.
8. Dashboard "run pending" button clicked in a browser; approve was exercised, run behavior is tested separately.
9. Fully concurrent multi-process state edits. A run lock prevents two active scheduler runs; plan/policy edits should still be serialized by the operator.

## Next verification steps

1. Install Node 20+ and the Codex CLI on the target machine.
2. From the workspace root: `codex plugin marketplace add .`, open `/plugins`, install AgentOrchestra, start a new session, and confirm the `agentorchestra` skill and 17 MCP tools load.
3. Install/verify the OpenCode plugin on a clean profile; confirm `/orchestra-status` and `/orchestra-run` appear and the skill is discoverable.
4. Confirm the host catalogue as `subscription`/`trusted` or `local`, then create one trivial public task and run it with `--provider host-opencode` (OpenCode) or `--provider codex` (Codex). Confirm the bridge/CLI receives the prompt, artifacts are captured, and a real (not simulated) evidence class is recorded.
5. Run one confidential task with a local/trusted model and confirm no public endpoint is contacted.
6. Approve one gate through the dashboard and one through MCP.
7. Add a real SolidWorks adapter in an isolated test assembly, with a process-level mutex and rollback.
8. Re-calibrate model capability/price metadata before trusting routing on paid work.
