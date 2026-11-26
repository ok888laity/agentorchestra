---
name: AgentOrchestra
description: Cost-aware, verification-driven multi-model orchestration for long, multi-module work. Use for DAG decomposition, budget/privacy-aware model routing, independent review, human gates, resource locks, or resumable execution.
---

# AgentOrchestra (project skill)

The canonical instructions are maintained at:

`../../../AgentOrchestra/SKILL.md`

Read that file now and follow it. All commands run from `../../../AgentOrchestra`.

Non-negotiable rules:

- The main model keeps L0 architecture, safety and release decisions; a human closes engineering gates.
- Mock/simulated output is not evidence. Never present it as real verification.
- Confidentiality 2 requires local models; confidentiality 1 requires trusted/local. Public free endpoints are not allowed.
- Default strict zero-extra-paid. If no adequate model fits, pause or escalate; never lower the acceptance bar.
- One writer per resource such as `solidworks:assembly`.
- Report subscription quota as `unknown`, never as a fabricated number.

Quick entry:

```bash
cd ../../../AgentOrchestra
node src/cli.js doctor
node src/cli.js demo --reset
node src/cli.js status
```

The MCP server is registered in the workspace `opencode.json`; prefer its `orchestra_*` tools when available.
