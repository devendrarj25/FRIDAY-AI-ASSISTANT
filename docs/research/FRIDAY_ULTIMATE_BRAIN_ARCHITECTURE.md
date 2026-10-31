# FRIDAY — Ultimate Brain Architecture

_FRIDAY - AI ASSISTANT. A Private, Autonomous and Self Learning OS Based on Local & Cloud Models._

The target architecture for the Brain evolution, written 2026-10-30 after the repository audit and the research in [FRIDAY_BRAIN_INTELLIGENCE_RESEARCH.md](FRIDAY_BRAIN_INTELLIGENCE_RESEARCH.md). It is a map of what exists, which module owns each job, and where the next changes attach. **It adds no new subsystem.** Every row names an existing owner; the roadmap in [FRIDAY_BRAIN_IMPLEMENTATION_ROADMAP.md](FRIDAY_BRAIN_IMPLEMENTATION_ROADMAP.md) extends those owners phase by phase.

## 1. The rule this architecture follows

FRIDAY already has one cognitive pipeline, one model router, one memory engine, one task graph, one governance gate and one capability registry. The evolution extends them. A change that needs a second router, second memory store, second scheduler or second agent runtime is rejected (AGENTS.md, "Edit what exists"). The model is an engine; the identity, the authority rules and the approval gate belong to FRIDAY and cannot be changed by a model, a plugin or a document.

## 2. The existing Brain in one picture

```
 owner / voice / chat / schedule / event
              │
   src/lib/friday/brain-engine.ts        BrainStore: the run, its stages, the chat state
              │
   brain/core-brain.ts                   cognize → (model call) → verify → reflect → learn
     ├─ brain/intent-engine.ts           what is being asked; correction detection
     ├─ brain/cognitive-route.ts         simple / normal / complex / high-stakes / unknown / repeated
     ├─ brain/cognitive-control.ts       reasoning mode (≤ 3 scored), context ranking, verification debt
     ├─ brain/cognitive-runtime.ts       state machine, goal stack, inhibition gates, ranked forgetting
     ├─ brain/cognitive-mind.ts          uncertainty kinds, decision record, commitments, replanning
     ├─ brain/context-engine.ts          token-budgeted context packet
     ├─ brain/meta-reasoner.ts           known / unknown / stale; next action; answer self-checks
     ├─ brain/confidence.ts              weakest-link confidence from the capability matrix
     ├─ brain/decision-engine.ts         route: baseline / memory / web / tool / skill / model / confirm / ask
     ├─ brain/orchestrator.ts            roles (fast, planner, coder, reviewer, tester, reasoner, vision, audio)
     ├─ brain/model-registry.ts          models, health, cooling-down, candidates per role
     ├─ brain/cost-policy.ts             free-first and the owner's spend rules
     ├─ brain/multi-model.ts + reconciler.ts   second opinions, merge, identity scrub
     ├─ brain/retrieval.ts + research.ts + knowledge-base.ts + knowledge-graph.ts + memory-fabric.ts
     ├─ brain/answer-checks.ts + verified-run.ts   deterministic checks, fix once, escalate
     └─ brain/*-router.ts, *-forge.ts    agent / skill / tool / module / plugin / workflow routing and creation
              │
   self/task-graph.ts (+ task-runners, task-ledger, run-receipt)    durable multi-step work
   self/governance.ts (+ own-work, limitation-loop)                  proposals → approval → apply → rollback
   self/memory-engine.ts (+ memory-consolidate)                       six tiers, supersede, archive, restore
   self/learning-engine.ts, skill-loop.ts, finetune.ts, mastery.ts    experience → skill → (optional) adapter
   self/autonomous-core.ts + agent-scheduler.ts                       the one idle timer
   self/capability-matrix.ts, intelligence-benchmark.ts, eval-harness.ts, instruction-eval.ts    measurement
              │
   electron/model-router.cjs (+ models, model-capabilities, model-access, providers)   the authoritative route
   kernel/router.py, planner.py, authority.py, tools.py, memory.py, privacy.py         execution under tokens
```

## 3. The target lifecycle mapped onto what exists

The requested lifecycle is the existing path with named stages. Nothing is a new pipeline.

| Stage in the brief | Owner today | State | Change attaches here |
| --- | --- | --- | --- |
| Input, context assembly | `brain-engine.ts`, `context-engine.ts` | built | none |
| Intent understanding | `intent-engine.ts`, `reference-resolver.ts`, `settings-intents.ts` | built | Hinglish intent tests (Phase 2) |
| Task classification, complexity | `cognitive-route.ts`, `task-routing.ts` | built, coarse | per-model fit scoring (Phase 4) |
| Memory and knowledge retrieval | `retrieval.ts`, `memory-engine.ts`, `vector-index.ts`, `kernel/memory.py` | built, no reranker | entity and recency fusion, optional rerank (Phase 3) |
| Model selection | `orchestrator.ts`, `model-registry.ts`, `electron/model-router.cjs` | built, rule-based | measured per-model profile, reasoning adapter (Phase 4) |
| Planning | `task-graph.ts` `planNodes`, `kernel/planner.py` | built, list/then/parallel aware | shared plan context (Phase 5) |
| Specialist selection | `agent-router.ts`, `agent-scheduler.ts`, `agents/` | built, plan-only until approved | handoff versus agent-as-tool (Phase 5) |
| Execution, observation | `task-runners.ts`, kernel tools, `computer-use.ts` | built | none |
| Verification | `core-brain.verify`, `answer-checks.ts`, `verified-run.ts`, `meta-reasoner.evaluateAnswer` | built, not on streaming chat | wire to chat and Auto (Phase 2) |
| Reflection, error recovery | `cognitive-control.ts`, `bounded-retry`, `failure-guard`, `error-intelligence.ts` | built | none |
| Result synthesis | `reconciler.ts`, `core-brain.speakAsFriday` | built | none |
| Memory update, learning candidate | `core-brain.reflect`, `learning-engine.ts`, `skill-loop.ts` | built | none |
| Completion, trace | `decision-trace.ts`, `turn-trace.ts`, `run-receipt.ts` | built | OpenTelemetry-shaped export (Phase 12) |

## 4. Canonical module ownership for the evolution

| Capability group in the brief | Canonical owner (extend this) | Never create |
| --- | --- | --- |
| A, B Cognitive core and thinking engine | `cognitive-control.ts`, `reasoning.ts`, `meta-reasoner.ts` | a second reasoning engine |
| C Agents | `task-graph.ts`, `agent-scheduler.ts`, `agent-router.ts`, `agents/` manifests | an agent framework or message bus library |
| D Memory | `memory-engine.ts` (authority), `memory-fabric.ts` (what may influence a turn), `kernel/memory.py` (vector) | another memory store |
| E Multi-model fusion | `electron/model-router.cjs`, `model-capabilities.cjs`, `model-registry.ts`, `multi-model.ts` | another router or registry |
| F Continuous learning | `learning-engine.ts`, `skill-loop.ts`, `task-ledger.ts` experiences | another learning store |
| G Self-development | `governance.ts`, `own-work.ts`, `dev-pipeline.ts`, `limitation-loop.ts` | a path that writes without the gate |
| H Research | `research.ts`, `retrieval.ts`, `browser-engine.ts`, `knowledge-base.ts` | a second search stack |
| I Capability intelligence | `capability-registry.ts`, `*-forge.ts`, `electron/mcp-protocol.cjs` | trusting an unknown tool |
| J Multimodal | `format-atlas.ts`, `electron/stt.cjs`, `screen-vision.cjs`, `image-generation.cjs`, `kernel/media_tools.py` | another media pipeline |
| K Computer use | `self/computer-use.ts`, kernel `input.*`, `screen.*` | actions outside the permission levels |
| L Metacognition | `self-atlas.ts`, `world-model.ts`, `confidence.ts`, `cognitive-runtime.ts` self-model | claims of consciousness |
| M Proactive | `autonomous-core.ts`, `horizon-goals.ts`, `atlas-notices.ts` | a new always-on timer |
| Evaluation | `eval-harness.ts`, `instruction-eval.ts`, `intelligence-benchmark.ts` | claims without a number |

## 5. Model integration strategy

- **One record per model** in `model-capabilities.cjs` (declared by source, then curated, then heuristic, each labelled). The evolution adds fields to that record, not another registry:
  - `reasoning`: which control the model takes (`effort`, `enable_thinking`, `budget`, `always`, `none`) and whether reasoning content must be kept across tool turns. This is the Phase 4 adapter and answers the fact that newer Claude models reject a token budget and that Qwen3 serving can drop reasoning content.
  - `profile`: measured pass rate on FRIDAY's own fixed tasks, median latency and cost per call, written only from real runs (the Compare run and live turns) with a count and a date. A model with no runs shows "not measured", never a guess.
- **Routing** stays free-first inside the privacy and billing firewalls. The measured profile ranks candidates within what the firewalls already allow; it never widens what a model may see or cost.
- **Collaboration** (research by A, analysis by B, verification by C, FRIDAY synthesises) runs only when `multi-model.ts` already says the gap justifies it and an objective check can choose; otherwise one model plus the check loop.
- **Adapters, not clones.** The common surface is the OpenAI-style and Anthropic wire the router already speaks; a new provider is a `CLOUD` entry with its capabilities. Nothing pretends one model has another's weights or hidden reasoning.

## 6. Storage implications

| Data | Where it lives now | Evolution impact |
| --- | --- | --- |
| Six memory tiers, supersede and archive | `friday.memory.*` state through `persist.ts` | none; add `entities` and `validFrom/validTo` fields as optional, migrated on read |
| Vector index | `<root>/database` via `kernel/memory.py` (Chroma or hashed n-gram) | optional second-stage rerank at read time; no change to stored vectors |
| Experiences, ledger, receipts | `task-ledger.ts` state | add the reasoning setting and measured latency per call to the experience record |
| Model profile | new optional field on the model record in the models state | migrated: absent means "not measured" |
| Evaluation history | none (runs are not stored) | store last N reports so a trend can be shown; local only |
| Traces | `turn-trace.ts`, `decision-trace.ts` in memory | optional local export file, never uploaded |

All additions are optional fields read with defaults, so an older state file loads unchanged, and install, update and uninstall keep the data rules in the storage contract.

## 7. Security and governance design (unchanged invariants)

- External model output, retrieved text, tool output and files are **data**. The answer checks, the skill screen and the injection isolation already enforce this; each phase adds a test that new text paths are screened.
- Authority is minted by the kernel (`authority.py`) per task, action, argument hash, target, risk and expiry. A child agent cannot exceed its parent. No phase changes this.
- Anything that changes FRIDAY herself goes through `governance.ts` (always-ask `code-change`), is backed up, verified against a checked postcondition and rolled back on failure. `PROTECTED_POLICY_FILES` stay protected.
- Secrets stay in `safeStorage`; SENSITIVE data stays off cloud models (privacy firewall); paid and unknown-cost models stay hidden until paid access is on (billing firewall).
- New capabilities start quarantined and are validated on held-out cases before they can be routed (`*-forge.ts`, `skill-loop.ts`).
- No automatic production deployment, no workflow run, no push to `main`, no version bump by any phase.

## 8. Observability

The Brain page, Status page and the Self-management page already show cognition notes, verification, capability scores, governance queue, the offline eval and (new) the model comparison. Phase 12 adds, from data that already exists: active mode, selected reasoning setting, active model and why, task graph with its parallel groups, memory retrievals used in the last turn, check results, and the last measured profile. It shows steps and reasons, never a model's hidden reasoning.

## 9. What is out of scope here

A new framework, a new database, GPU-only features as a requirement, any feature that sends private data to a provider without both firewalls, training a model's weights as a default, and any claim that FRIDAY is smarter than a provider's model without a measured number.
