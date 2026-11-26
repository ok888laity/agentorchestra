# Security and data boundaries

## Trust model

AgentOrchestra is a **local operator tool**. It assumes:

- the person running it is trusted;
- configured provider commands and scripts are trusted;
- the workspace and `.orchestra/` are not shared with untrusted users;
- the dashboard is reached only over loopback.

It is **not** a multi-tenant sandbox. Provider CLIs and script nodes run with the host user's authority.

## Data classification

Task confidentiality:

| Level | Meaning | Required model boundary |
| --- | --- | --- |
| 0 | public | public / trusted / local |
| 1 | internal | trusted / local |
| 2 | confidential | local only |

Model privacy:

| Value | Meaning | Rank |
| --- | --- | --- |
| `local` | self-hosted/local endpoint | 3 |
| `trusted` | contractual/private endpoint with acceptable data policy | 2 |
| `public` | public/free endpoint or unknown data retention | 1 |
| `unknown` | not configured | 0 |

The router requires `modelRank ≥ confidentiality + 1`. Unknown privacy is rejected unless `allowUnknownPrivacy` is explicitly enabled. Discovered models default to `public`.

## Secrets

- API keys are read from environment variables named in config, never written to state.
- Context construction redacts common key patterns and `<private>...</private>` blocks.
- The prompt/context preview records that redaction occurred, not the secret value.
- The dashboard never displays keys; `doctor` reports only “set/missing”.
- Do not put secrets in task briefs, notes or artifacts. Redaction is best-effort, not a guarantee.

## Budget

- Default `zeroExtraPaid: true` makes API-cost models ineligible.
- API estimates reserve budget before dispatch and reconcile after completion.
- Estimates are guards, not invoices; actual provider billing may differ.
- A budget stop leaves tasks `waiting_budget`; it never lowers acceptance.
- Subscription token usage is tracked separately; remaining quota is reported `unknown` because no stable public API is available.

## Scripts

- `script` tasks require `allowScripts: true`.
- The executable basename must be in `allowedExecutables`.
- Commands are arrays, executed without a shell, inside the task workspace, with a 5-minute timeout.
- The command itself is trusted plan data. Do not accept script arrays from untrusted users.
- This is not a filesystem/network sandbox. A malicious script can still access the host account.

## Providers

- CLI adapters spawn configured commands with a prompt file in the task directory.
- On Windows, arguments containing shell metacharacters are refused; model IDs and config come from trusted local files.
- The OpenAI-compatible adapter sends the context packet to the configured endpoint. Confirm its data policy before setting `privacy: trusted`.
- OpenCode/Codex flags are templates; verify them. A wrong flag must fail, not silently run a different mode.
- If a provider returns suspicious output, it is treated as untrusted text. It cannot change policy, locks or approval state.

## SolidWorks / shared files

- V1 does not call a CAD kernel.
- It enforces a lease on resources such as `solidworks:assembly`.
- A real SolidWorks adapter must add its own process-level mutex and save/rollback protocol; the DAG lock is necessary but not sufficient.
- Never run two writers against one assembly, even if the DAG says they are independent.

## Dashboard

- Binds to `127.0.0.1`, `localhost` or `::1` only.
- Rejects POSTs with a non-loopback `Origin`.
- No authentication; do not expose it through a public reverse proxy without adding auth.
- Artifact endpoint only serves `latest/...` under `artifacts/<task>/`, with traversal protection.

## Mock provider

- Every mock artifact and response is labelled `SIMULATED`.
- The dashboard warns when accepted results are simulated.
- A simulated run proves orchestration, not engineering correctness.
- Do not use mock output for design, patent, safety or release decisions.

## Known limitations

- JSON store is single-process; concurrent schedulers can corrupt intent.
- No OS sandbox, seccomp, container or network egress control.
- No encrypted state at rest.
- No signed audit log; journal is append-only but local.
- Context redaction is best-effort.
- Provider cost/quality metadata is user-maintained and may drift.
