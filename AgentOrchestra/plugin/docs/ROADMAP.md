# Roadmap

## V1 — usable local scheduler (this repository)

- [x] DAG plan validation, depths, cycle detection
- [x] Cost/quality routing with hard privacy and budget gates
- [x] Model registry, role weights, history adjustment
- [x] Evidence gates, review, human gates
- [x] Resource locks, artifact versions, resume
- [x] Mock provider, CLI templates, OpenAI-compatible adapter
- [x] CLI, MCP server, local dashboard
- [x] Test suite and routing eval
- [x] Skill/documentation and prior-art record
- [x] Dual-host plugin bundle (Codex `plugin.json`/skills/MCP; OpenCode `Plugin.define`)
- [x] OpenCode plugin loaded live and registered 17 MCP tools
- [ ] Codex plugin install verified through Codex CLI
- [ ] OpenCode plugin commands/approval flow exercised in the UI

## V2 — verified real-world execution

- [ ] Smoke-test and pin OpenCode/Codex CLI flags per version
- [ ] OpenCode HTTP/SDK adapter instead of only CLI
- [ ] SQLite store adapter (keep JSON for portability)
- [ ] Worktree isolation for code-writing tasks
- [ ] Real token/cost calibration from provider usage
- [ ] Capability calibration from task outcomes
- [ ] Dashboard approval auth and remote-access story
- [ ] Structured cancellation/abort propagation into provider calls
- [ ] Better context packing (index → details on demand)
- [ ] Provider circuit breakers and rate-limit backoff
- [ ] Cost reservation hardening (actual vs estimate reconciliation)

## V3 — team and engineering integrations

- [ ] Multi-project service with per-project roots
- [ ] Remote workers/hosts with policy enforcement
- [ ] SolidWorks adapter with process mutex, save/rollback, assembly diff
- [ ] PDM/PLM/Git artifact integration
- [ ] Team budgets, approvals and audit export
- [ ] Historical routing optimization (contextual bandit/Thompson sampling)
- [ ] Encryption at rest and signed audit journal
- [ ] Optional Docker/OS sandbox for untrusted tasks

## Explicit non-goals

- Controlling arbitrary ChatGPT/Claude web chat windows.
- Infinite recursive agent spawning.
- Replacing human engineering acceptance.
- Claiming exact subscription quota without a provider API.
- Treating free models as safe for confidential data.
