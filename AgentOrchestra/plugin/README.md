# AgentOrchestra plugin

This folder is the installable dual-host bundle for **Codex** and **OpenCode**. It contains the scheduler core, a stdio MCP server, the AgentOrchestra skill, and an OpenCode server plugin.

## Codex

The plugin exposes a single portable `plugin.json` (with OpenAI settings under `extensions.com.openai`), `skills/agentorchestra/SKILL.md`, and a stdio MCP server via `mcp.json` / `.mcp.json`. There is deliberately no `.codex-plugin/plugin.json` to avoid duplicate-name collisions.

Local repository marketplace (from the workspace root):

```bash
codex plugin marketplace add .
codex
/plugins
```

Alternatively copy this folder to `~/.codex/plugins/agentorchestra` and add a personal marketplace entry at `~/.agents/plugins/marketplace.json` pointing at it. See `../docs/PLUGIN_INSTALL.md`.

The bundled MCP server runs `node ./server/launch-mcp.js` with the plugin root as cwd. State defaults to `PLUGIN_DATA` or `~/.agentorchestra`; bundled `config/` is used as a fallback. Do not edit the installed cache for persistent policy.

## OpenCode

Add the plugin to the workspace `opencode.json`:

```json
{
  "plugins": [
    { "package": "./AgentOrchestra/plugin", "options": { "root": "./AgentOrchestra" } }
  ]
}
```

The OpenCode server part registers the local MCP server automatically, adds the AgentOrchestra skill, adds `/orchestra-status`, `/orchestra-run` and `/orchestra-models` commands, and refreshes the host model catalogue on setup and before each prompt. It also starts a loopback execution bridge so the scheduler can run the user's already-authenticated host models through OpenCode's own model layer instead of requiring a separate CLI or API key. Set `hostBilling` / `hostPrivacy` in plugin options only after confirming the provider's billing and data policy; unknown values stay excluded.

## Verify

```bash
node server/cli-plugin.js doctor
node server/cli-plugin.js demo --reset
node server/cli-plugin.js status
```

The demo is simulated; it proves orchestration only. Real engineering evidence requires a configured real provider.

## Layout

- `server/` — bundled scheduler, CLI and MCP server.
- `config/` — model catalog and policy defaults.
- `examples/` — starter, recursive and subsea simulation DAGs.
- `skills/agentorchestra/SKILL.md` — host skill.
- `opencode-server.js` — OpenCode server plugin.
- `plugin.json` — single portable manifest for Codex and OpenCode.
- `mcp.json`, `.mcp.json` — portable and compatibility MCP config.

