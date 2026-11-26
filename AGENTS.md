# Workspace agent instructions

For any long, multi-module, multi-model, budget-constrained or resumable task, read and follow:

`AgentOrchestra/SKILL.md`

AgentOrchestra is the orchestration entry point in this workspace. Run its commands from `AgentOrchestra/`:

```bash
cd AgentOrchestra
node src/cli.js doctor
node src/cli.js status
node src/cli.js run
```

Hard rules:

- L0 architecture/safety/release decisions stay with the main model or a human gate.
- Never present mock/simulated output as real engineering evidence.
- Never send confidential/patent text to public or unknown-privacy models.
- A failed quality gate or exhausted budget pauses or escalates; it never lowers the acceptance bar.
- One writer per shared resource such as `solidworks:assembly`.
- Report subscription remaining quota as `unknown`; do not fabricate it.

Plugin entry points:

- OpenCode: `opencode.json` loads `./AgentOrchestra/plugin`; it auto-registers the MCP server, skill, `/orchestra-status` / `/orchestra-run` / `/orchestra-models`, and host-model refresh hooks.
- Codex: install from `.agents/plugins/marketplace.json`; the bundle has `plugin.json`, `.codex-plugin/plugin.json`, `skills/` and stdio MCP.
- Standalone: `node AgentOrchestra/src/cli.js demo --reset`, then `status`.

Useful commands (from `AgentOrchestra/`):

- `node src/cli.js demo --reset` — offline proof of the full pipeline.
- `node src/cli.js plan --file examples/subsea-rig.json` — simulated subsea rig DAG.
- `node src/cli.js dashboard --port 8765` — local console.
- `node src/mcp.js` — direct MCP fallback.
- `npm run build:plugin && npm run verify:plugin` — rebuild/verify both plugin manifests.

If a task is small and single-module, do it directly; do not spin up a swarm.
