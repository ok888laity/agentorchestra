# AgentOrchestra

**Cost-aware, verification-driven multi-model orchestration — packaged as a one-click plugin for OpenCode and Codex.**

AgentOrchestra is not a chat-agent swarm demo. It is a deterministic scheduler with DAG tasks, cost/quality routing under hard privacy and budget gates, evidence-bound acceptance, independent review, human gates, single-writer resource locks, versioned artifacts, resumable JSON state, a CLI and an MCP server. The main model keeps all decisions; workers are bounded role-specialized slots.

## One-click start

### One line from GitHub (when the host CLI is installed)

OpenCode — installs the plugin globally from GitHub, so it is available in every conversation of every project:

```bash
opencode plugin add 'github:ok888laity/agentorchestra#main::path:AgentOrchestra/plugin'
```

Codex — registers the repository marketplace and installs the plugin user-wide (all sessions):

```bash
codex plugin marketplace add ok888laity/agentorchestra && codex plugin add agentorchestra@agentorchestra-local
```

After either command, start a new conversation. In OpenCode run `/orchestra-models` once to classify providers and make your own billing/privacy choice.

### Auto-install for OpenCode + Codex (one script)

```bash
git clone https://github.com/ok888laity/agentorchestra.git
cd agentorchestra
node AgentOrchestra/scripts/install.js
```

The installer detects which host(s) are present and registers the plugin idempotently:

- **OpenCode**: adds the plugin to the project `opencode.json` so every conversation in this project auto-loads it. Add `--global` to also register it in `~/.config/opencode/opencode.json` for every project.
- **Codex**: enables the project entry in `.codex/config.toml` and, when the Codex CLI is available, runs `codex plugin marketplace add .` + `codex plugin add agentorchestra@agentorchestra-local` (user-wide, so every session gets it).

Use `--host opencode|codex` to force one, `--dry-run` to preview, `--json` for machine output. Nothing is enabled until you confirm billing/privacy in `/orchestra-models`.

### OpenCode — clone and run

```bash
git clone <this-repo-url> agentorchestra
cd agentorchestra
opencode
```

The root `opencode.json` already loads `./AgentOrchestra/plugin`. On startup the plugin auto-registers:

- the `agentorchestra` MCP server (17 tools)
- the `agentorchestra` skill
- `/orchestra-status`, `/orchestra-run`, `/orchestra-models`
- host model + provider metadata refresh hooks

Then, **as a first-run user, choose your own billing/privacy boundary**:

```text
/orchestra-models
```

That command classifies every discovered provider with evidence and confidence. Confirm each one with `orchestra_set_provider_policy`; your choice is stored in your own `.orchestra/host-policy.json`. The plugin ships **neutral defaults with every provider disabled** — nothing is enabled or sent anywhere until you decide.

### Codex — marketplace install

From the repo root:

```bash
codex plugin marketplace add .
codex
/plugins
```

Install **AgentOrchestra** and start a new session. The bundle contains `plugin.json`, `.codex-plugin/plugin.json`, the skill, a stdio MCP server, and a `SessionStart` hook that reads only auth mode / local model cache (never token values) to refresh Codex host models.

### In-app UI (no web console)

OpenCode Desktop shows a native **AgentOrchestra** settings page (Settings → AgentOrchestra, or the composer pill). Everything — provider confirmation, plan submit, pool planning, route preview, run and update check — is done there with the app's own controls. No web console is started.

### Standalone CLI (no install, Node.js 20.11+)

```bash
cd AgentOrchestra
node src/cli.js doctor
node src/cli.js demo --reset
node src/cli.js status
```

The demo is simulated: it proves orchestration, budgets, locks, gates and resume — not engineering correctness. Real model calls require a configured provider.

## What is in this repo

| Path | Purpose |
| --- | --- |
| `opencode.json` | OpenCode entry point — load the plugin from the cloned repo |
| `.agents/plugins/marketplace.json` | Codex local marketplace entry |
| `.codex/config.toml` | Codex plugin enable entry |
| `AgentOrchestra/` | The product: core, plugin bundle, docs, tests, examples |
| `AgentOrchestra/plugin/` | Generated dual-host plugin bundle (Codex + OpenCode) |
| `AgentOrchestra/README.md` | Full documentation |
| `AgentOrchestra/docs/PLUGIN_INSTALL.md` | Installation and first-run provider choice flow |
| `AgentOrchestra/docs/VERIFICATION.md` | Test / live verification record |

## Rebuild after changes

```bash
cd AgentOrchestra
npm run build:plugin
npm run verify:plugin
npm test
```

## Honest status

- Offline demo, OpenCode plugin path and one **real free `opencode-go` model** call are verified on the development machine (45 tests, 8/8 routing eval, 10/10 plugin checks).
- Mock output is explicitly labelled `simulated` and is never engineering evidence.
- Paid/subscription domestic models and real Codex model calls were not exercised.
- Subscription quota is reported as `unknown`, never fabricated.
- Privacy `trusted` is only ever a user choice, never inferred from technical metadata.

See [`AgentOrchestra/docs/VERIFICATION.md`](AgentOrchestra/docs/VERIFICATION.md).

## License

MIT. See [`LICENSE`](LICENSE).
