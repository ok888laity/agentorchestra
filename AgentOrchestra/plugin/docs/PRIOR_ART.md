# Prior art and what was borrowed

This project was designed after inspecting active open-source projects in the same problem space. No source code was copied. The table records the pattern, the source, and how V1 uses it.

| Project | Pattern worth borrowing | What AgentOrchestra does | What it deliberately does not do |
| --- | --- | --- | --- |
| [Token-Beggar](https://github.com/Arthur031221/Token-Beggar) | Route to the cheapest model that still does the job; the orchestrator verifies the work; never invent savings | Adequacy-first routing, deterministic + model review, honest cost reporting, `doctor`, simulated/real labels | No claim of measured savings; no hidden host hooks |
| [claude-model-router](https://github.com/korelex/claude-model-router) | Config-driven tiers, deterministic heuristics first, auto-escalate one tier on failure, skill + MCP entry | Config-driven models/roles, deterministic scoring, exclude-tried escalation, MCP tools | No Claude-only vendor lock; no LLM classifier in V1 |
| [moai-adk](https://github.com/modu-ai/moai-adk) | Evidence-bound completion, TRUST-style gates, single-writer worktrees, turn/wall-clock/stagnation limits, resume | No unverified success claims, artifact checks, resource locks, wall clock + stagnation guard, JSON state resume | No full SPEC lifecycle UI; no worktree engine yet |
| [LoopForge](https://github.com/Tencent/LoopForge) | Agent + script + human-gate DAG, per-node artifacts, approval/rework | `agent`, `script`, `review`, `approval` nodes; versioned artifacts; human gate; script evidence | No Docker sandbox; no visual LOOP designer |
| [Omnigent](https://github.com/omnigent-ai/omnigent) | Meta-harness across Codex/OpenCode/etc.; policies, spend caps, cross-vendor review | Provider hub, policy gates, cross-provider reviewer preference, CLI/MCP surfaces | No remote multi-user server; no cloud sandboxes |
| [claude-mem](https://github.com/thedotmack/claude-mem) | Progressive disclosure memory; private blocks; cross-agent recall | Tagged notes, clearance filtering, compact memory index, `<private>` redaction, context budgets | No vector DB / semantic search in V1 |
| [agency-agents-zh / agency-orchestrator](https://github.com/jnMetaCode/agency-agents-zh) | Role catalog + DAG collaboration | Role weight profiles, DAG tasks, group progress | No 277-role catalog; roles are small and configurable |
| [FrugalGPT](https://arxiv.org/abs/2305.05176) (paper; cascades) | Cheap-first cascades with escalation and a quality stop condition | Exclude-tried escalation, hard acceptance bar, budget stop | No trained cascade scorer |
| [OpenCode](https://github.com/anomalyco/opencode) | Skills, MCP, CLI automation, local service | `SKILL.md`, MCP stdio server, CLI template, project skill pointer | No direct control of arbitrary web chat |
| [OpenAI Codex CLI](https://github.com/openai/codex) | Headless `codex exec` automation | Configurable CLI adapter and doctor probe | Flags are unverified until smoke-tested locally |

## Design conclusions taken from the survey

1. **The scheduler, not the model, must own state.** Conversation memory is not a durable job queue.
2. **The cheapest answer is not the cheapest task.** Retries and rework dominate; adequacy must be checked first.
3. **Verification must be outside the producer.** A separate reviewer/provider and deterministic checks reduce self-grading.
4. **More agents is not automatically cheaper.** Context duplication and coordination can exceed the savings; depth/concurrency caps are mandatory.
5. **Approval is a node, not a sentence.** Human gates and script nodes belong in the DAG, with evidence.
6. **Single-writer isolation is non-negotiable** for CAD/assembly/shared files.
7. **Report unknown as unknown.** Quota and savings claims without measurement are worse than no number.

## Licenses

The referenced projects use MIT, Apache-2.0 or similar permissive licenses. This project is MIT. If future code is copied rather than reimplemented, the source and license must be recorded here and in the file header.
