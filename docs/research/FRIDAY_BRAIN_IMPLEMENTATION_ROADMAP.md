# FRIDAY — Brain Implementation Roadmap

_FRIDAY - AI ASSISTANT. A Private, Autonomous and Self Learning OS Based on Local & Cloud Models._

The phased plan for the Brain evolution, written 2026-10-30. Phase 0 (the audit, research and these five documents) was the first step; the owner then asked for the code itself, so one pull request carries the documents and the delivered parts of the phases below. The phases are **a planning structure over existing owners, not permission to create new subsystems**.

Inputs: [FRIDAY_BRAIN_INTELLIGENCE_RESEARCH.md](FRIDAY_BRAIN_INTELLIGENCE_RESEARCH.md), [FRIDAY_ULTIMATE_BRAIN_ARCHITECTURE.md](FRIDAY_ULTIMATE_BRAIN_ARCHITECTURE.md), [FRIDAY_BRAIN_CAPABILITY_MATRIX.md](FRIDAY_BRAIN_CAPABILITY_MATRIX.md), [FRIDAY_BRAIN_GAP_ANALYSIS.md](FRIDAY_BRAIN_GAP_ANALYSIS.md).

## Delivered so far

| Phase | Delivered in code | Still open |
| --- | --- | --- |
| 1 Contracts | model record `reasoningControl` with its source; the model profile store; result record, intervals, fixtures and stage switches (`eval-stats`, `eval-fixtures`, `stage-switches`); a security gate suite | parity test between the main-process record and the renderer registry; none |
| 2 Reasoning and context | per-model reasoning control, effort per route, same-engine repair on the streaming chat, the Hub on the verified ask | none known |
| 3 Memory | time and tense aware ranking, Hinglish bridge, folded owner forms, per-fact validity, entity aliases, optional reranker hook, tests for the vector index and for the engine being the authority | an installed cross-encoder model |
| 4 Model fusion | measured profile feeds ranking, repeated instruction comparison | role assignment by measured strength |
| 5 Agents and tasks | shared earlier results, parallel groups, delegation modes, delegated authority limited to the overlap, risk tier in the child check, mailbox between enrolled agents | A2A with an outside agent (deferred) |
| 6 Research | source kinds, agreement, citation check, tool argument validation | MCP revision comparison (docs host blocked) |
| 7 Learning | trainer guards tested, failure-pattern mining filed through the limitation loop, promotion verdict | a real training run on the owner's PC |
| 8 Self-development | `dev.check` sandbox, `devCheckRequest` and `devCheckAllows` | the owner runs it per proposal (exec tier, never automatic) |
| 9 Multimodal | `media.transcribe`, the video method in the turn notes | one sound-and-picture pass, realtime |
| 10 Proactive | heads-up before a desk deadline, goal deadlines on the desk, battery-aware idle pass, failure mining on the idle cycle | event rules from outside the app, CPU-load awareness |
| 11 Benchmarking | the 75-category bank (41 scored in the app), retrieval, routing, long-horizon, tool-choice and recall fixtures, pass-k, intervals, history, stored results, ablation, one gate report, A/B script, outside-benchmark rules and judge | running the outside benchmarks and a judge on a real model (the owner's keys); fixtures for model-needing and desktop-needing categories |
| 12 Observability | Brain now panel, run id to the kernel, local redacted trace (opt-in) | none; the OpenTelemetry exporter stays rejected |

## 1. How phases are ranked

Each phase is scored 1 (low) to 5 (high) on the criteria below. **Priority = impact + value + compatibility − complexity − risk − cost − performance cost**, shown so the order can be argued with, not as a measurement.

| Phase | Intelligence impact | User value | Compat. | Complexity | Reliability risk | Security risk | Operating cost | Performance cost | Score | Planned order |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 Contracts | 2 | 2 | 5 | 1 | 1 | 1 | 1 | 1 | **4** | 1 |
| 2 Reasoning and context | 5 | 5 | 4 | 2 | 2 | 1 | 2 | 2 | **5** | 2 |
| 4 Multi-model fusion | 4 | 4 | 4 | 3 | 2 | 2 | 2 | 1 | **2** | 3 |
| 11 Benchmarking | 4 | 3 | 5 | 2 | 1 | 1 | 2 | 1 | **5** | 4 |
| 3 Memory and knowledge | 4 | 4 | 4 | 3 | 2 | 2 | 1 | 2 | **2** | 5 |
| 5 Agents and tasks | 4 | 4 | 3 | 4 | 3 | 3 | 3 | 2 | **-4** | 6 |
| 6 Research and capabilities | 3 | 4 | 4 | 3 | 2 | 3 | 2 | 2 | **-1** | 7 |
| 12 Observability and UI | 2 | 4 | 5 | 2 | 1 | 1 | 1 | 1 | **5** | 8 |
| 7 Continuous learning | 3 | 3 | 4 | 3 | 3 | 3 | 1 | 1 | **-1** | 9 |
| 10 Proactive and long horizon | 3 | 3 | 3 | 3 | 3 | 3 | 2 | 2 | **-4** | 10 |
| 9 Multimodal and computer use | 3 | 3 | 3 | 4 | 3 | 4 | 3 | 3 | **-8** | 11 |
| 8 Controlled self-development | 4 | 3 | 3 | 5 | 4 | 5 | 2 | 2 | **-8** | 12 |

The score alone would put 2, 11 and 12 first. The planned order follows the dependency map instead: Phase 1 first because it unblocks 2 and 4 at almost no cost, 11 before the phases that need its numbers, and 12 late because it shows what the others produce. Two phases with the same score are ordered by what they unblock.

Phase 11 runs beside every other phase: no phase is accepted without its before and after numbers.

## 2. Dependency map

```
Phase 0 (this change)
   └─► Phase 1 contracts ──► Phase 2 reasoning + chat verification ──┐
            │                                                        ├─► Phase 12 observability
            ├─► Phase 4 model fusion (needs the `reasoning` and `profile` fields) ─┤
            ├─► Phase 3 memory + knowledge ──► Phase 6 research + capabilities     │
            └─► Phase 11 benchmarking (runs beside all) ───────────────────────────┘
Phase 5 agents and tasks   needs Phase 2 (verification) and Phase 11 (pass-k)
Phase 7 learning           needs Phase 11 (held-out discipline) and Phase 3 (versioned knowledge)
Phase 8 self-development   needs Phase 5, 7, 11 and the owner's explicit go-ahead
Phase 9 multimodal         needs Phase 4 (vision capability profile)
Phase 10 proactive         needs Phase 5 and 7
```

## 3. Phases

For every phase: owners are the existing modules named; the work is done in the order tasks, contracts, implementation, tests, relevant checks, regression run, owning-document update, `FRIDAY_STATE.md` update, report.

### Phase 0 — Repository audit and research (done)

Deliverable: these five documents, registered in the documentation index. Hosted Actions unverified. The blocked doc hosts (see the research document) are the only open research item.

### Phase 1 — Cognitive core and unified intelligence contracts

- **Owners:** `electron/model-capabilities.cjs`, `src/lib/friday/brain/model-registry.ts`, `cognitive-control.ts`, `cognitive-mind.ts`, `cognitive-runtime.ts`.
- **Tasks:** (1) add optional `reasoning` (control kind, keep-content flag) and `profile` (runs, pass rate, median latency, cost, date) to the model record, read with defaults so old state loads; (2) a parity test between the main-process record and the renderer registry; (3) contract tests for the three cognitive modules stating what each owns, so later phases cannot blur them.
- **Contracts:** `ModelReasoning = { control: "effort" | "enable_thinking" | "budget" | "always" | "none"; keepAcrossToolTurns: boolean }`; `ModelProfile` with `measuredAt` and `runs`, absent means "not measured".
- **Tests:** record parse and migrate, parity, three contract suites.
- **Complexity:** small. **Depends on:** nothing. **Authorization:** none.
- **Result expected:** no user-visible change; unblocks 2 and 4.

### Phase 2 — Advanced reasoning and context intelligence

- **Owners:** `electron/model-router.cjs` (send the control), `core-brain.ts` and `brain-engine.ts` (chat path), `answer-checks.ts`, `verified-run.ts`, `context-engine.ts`.
- **Tasks:** (1) pass the reasoning control per model record (effort for adaptive Claude models, `enable_thinking` for Qwen3, think-start for R1-style models, none otherwise) and keep reasoning content across tool turns where the record says so; (2) put `askVerified` on the streaming chat and Auto mode with a visible "checked" note and a retry budget; (3) a per-turn latency and token budget that can lower the strategy; (4) Hinglish intent tests.
- **Contracts:** the adapter never sends a control the record does not declare; reasoning content stays in the turn and is never written to memory or logs.
- **Tests:** scripted-provider tests for each control; chat-path test that a failing check triggers one fix then escalation; budget test.
- **Complexity:** medium. **Depends on:** 1. **Authorization:** none for the code; live provider behaviour stays unverified until the owner's keys are used.

### Phase 3 — Memory and knowledge intelligence

- **Owners:** `memory-engine.ts`, `memory-fabric.ts`, `retrieval.ts`, `vector-index.ts`, `kernel/memory.py`, `knowledge-graph.ts`.
- **Tasks:** entity extraction and linking on write; validity period on facts; recency-aware ranking for "current state" asks; optional local cross-encoder rerank of the top candidates; a test that no path reads a projection as authority; knowledge graph queried by retrieval.
- **Contracts:** all new fields optional and migrated on read; a superseded fact never appears in a current answer.
- **Tests:** retrieval quality set with fixed expected hits (recall at k) before and after; migration test.
- **Complexity:** medium. **Depends on:** 1. **Authorization:** a reranker model download is an install through the Install Manager with its checksum.

### Phase 4 — Multi-model capability fusion

- **Owners:** `model-router.cjs`, `model-capabilities.cjs`, `model-registry.ts`, `multi-model.ts`, `reconciler.ts`, Models page.
- **Tasks:** measured profile written from Compare runs and live turns; ranking inside the firewall-allowed set uses the profile; structured-output capability key; provider health history; role assignment for collaboration by measured strength; a direct Alibaba (Qwen) provider entry only if the owner wants it.
- **Contracts:** profile ranks, never widens what a model may see or cost.
- **Tests:** ranking with and without a profile; firewall tests unchanged and green.
- **Complexity:** medium. **Depends on:** 1, 2. **Authorization:** none; paid-model trials only on the owner's say.

### Phase 5 — Autonomous agents and task orchestration

- **Owners:** `task-graph.ts`, `task-runners.ts`, `agent-router.ts`, `agent-scheduler.ts`, `agent-runtime.ts`.
- **Tasks:** shared task context passed to each node; DAG planning where steps are independent (extend the parallel group to a graph); handoff versus agent-as-tool recorded per delegation; schema-checked agent outputs; per-step trace; cost-aware admission.
- **Contracts:** the supervisor owns the final result and cannot be bypassed; a child never exceeds its parent's authority.
- **Tests:** concurrency, cancellation, retry-only-the-failed-piece, resume, authority inheritance.
- **Complexity:** large. **Depends on:** 2, 11. **Authorization:** none, but write actions still ask.

### Phase 6 — Research and universal capability intelligence

- **Owners:** `research.ts`, `retrieval.ts`, `browser-engine.ts`, `capability-registry.ts`, `*-forge.ts`, `electron/mcp-protocol.cjs`.
- **Tasks:** source reliability rules (domain class, age, agreement); citation check (the claim appears in the cited text); research project object and report builder; MCP revision check against the live spec; capability retirement flow.
- **Tests:** fixed pages in a fixture folder, no network.
- **Complexity:** medium. **Depends on:** 3. **Authorization:** the blocked hosts must be allowed to read the live specs.

### Phase 7 — Continuous learning and experience optimisation

- **Owners:** `learning-engine.ts`, `skill-loop.ts`, `finetune.ts`, `task-ledger.ts`.
- **Tasks:** failure-pattern mining across tasks; learning history and trend; a trainer test for `kernel/finetune_lora.py` with a stub; wording audit so a memory update is never described as retraining.
- **Tests:** promote only verified; rollback; poisoning defence.
- **Complexity:** medium. **Depends on:** 3, 11. **Authorization:** each training run is approved by the owner.

### Phase 8 — Controlled self-development

- **Owners:** `governance.ts`, `own-work.ts`, `dev-pipeline.ts`, `limitation-loop.ts`.
- **Tasks:** a throwaway worktree where a proposal is applied, the relevant tests and the evaluation run, and a before and after report is attached to the governance item; security review of the diff; automatic rollback record.
- **Contracts:** never touches `main`, `AGENTS.md`, identity, versions, workflows or the protected policy files; always asks; no deployment.
- **Complexity:** large. **Depends on:** 5, 7, 11. **Authorization:** the owner's explicit go-ahead for this phase.

### Phase 9 — Multimodal and computer-use intelligence

- **Owners:** `media_tools.py`, `format-atlas.ts`, `screen-vision.cjs`, `computer-use.ts`.
- **Tasks:** pass video stills to a vision-capable model by profile; join the soundtrack transcript; screenshot-difference verification of a computer action; realtime audio only if a provider's realtime API is added through the router.
- **Complexity:** large. **Depends on:** 4. **Authorization:** computer actions keep the autonomy dial.

### Phase 10 — Proactive autonomy and long-horizon execution

- **Owners:** `autonomous-core.ts`, `horizon-goals.ts`, `agent-scheduler.ts`, `atlas-notices.ts`.
- **Tasks:** event triggers, a deadline monitor, load and battery awareness, bounded background research; all within the one idle timer.
- **Complexity:** medium. **Depends on:** 5, 7. **Authorization:** the owner's schedules and the dial.

### Phase 11 — Benchmarking, reliability and optimisation (beside every phase)

- **Owners:** `eval-harness.ts`, `instruction-eval.ts`, `intelligence-benchmark.ts`.
- **Tasks:** one evaluation owner with suites and a shared report; stored history; suites for tool selection, routing, memory retrieval, long-horizon, cost, latency; pass-k reliability and fault-labelled failures; a renewed held-out set each round.
- **Tests:** deterministic offline; stub models.
- **Complexity:** medium. **Depends on:** nothing.

### Phase 12 — Brain observability and UI integration

- **Owners:** Brain, Status and Self-management pages; `turn-trace.ts`, `decision-trace.ts`.
- **Tasks:** mode, objective, model and reason, graph with parallel groups, retrievals used, check results, learning activity, proposals, resource use, last measured profile; OpenTelemetry-shaped export to a local file.
- **Contracts:** shows steps and reasons only, never a model's hidden reasoning; existing design tokens.
- **Complexity:** small to medium. **Depends on:** 2, 4, 5.

## 4. Baseline benchmark plan

Run before Phase 1 and after every phase; report before and after on the same fixed tasks.

| Suite | What it measures | How | Needs |
| --- | --- | --- | --- |
| Rules kept | form, limits, JSON, language, sums | `instruction-eval.ts`, 20 asks, the owner's model | owner presses Compare |
| Diagnosis | error cause, localisation | `eval-harness.ts`, with held-out renewed | nothing |
| Self-state, format | probe-backed answers | `eval-harness.ts` | nothing |
| Safe change, refusal, injection | governance and isolation | `eval-harness.ts` | nothing |
| Retrieval | recall at k, wrong-fact rate | new fixed corpus and queries | nothing |
| Tool selection | right tool chosen from the shortlist | new fixed asks | nothing |
| Routing | right model class for a task, cost, firewall respected | stub registry | nothing |
| Reliability | pass-k over repeated runs | repeat the above k times with a real model | owner's model |
| Long horizon | multi-step task completed, resumed after a kill | scripted runners | nothing |
| Cost and latency | tokens, ms per task | recorded on the Compare run | owner's model |
| Security | injection, protected files, authority | existing suites plus new | nothing |

Rules: no claim of improvement without a before and after number from these; a figure measured on a set already used to fix failures is labelled development, and only a first blind run counts as held-out; offline stand-in numbers are never described as model quality.

## 5. Testing strategy

- **Unit and contract tests** per owner module in `core/__tests__` and `kernel/tests`, deterministic and date-free.
- **Integration**: chat path with a scripted provider; task graph with scripted runners; kernel tools with real ffmpeg and SQLite where present.
- **Agent workflow**: concurrency, cancel, resume, retry-the-failed-piece, authority inheritance.
- **Regression**: the locked set and the whole suite stay green in every phase; `preflight --full` before every push.
- **Failure recovery and long-running**: kill and resume tests on the task graph.
- **Security**: new text paths are tested as untrusted; protected files stay refused.
- **Windows**: every Windows path is labelled unverified until the owner runs it.

## 6. Estimated complexity and cost

| Phase | Size | Rough change | New dependency |
| --- | --- | --- | --- |
| 1 | S | fields, parity and contract tests | none |
| 2 | M | router pass-through, chat wiring, budgets | none |
| 3 | M | entities, validity, rerank | optional small cross-encoder |
| 4 | M | profile store, ranking, key | none |
| 5 | L | task graph DAG, context, traces | none |
| 6 | M | reliability rules, citation check, report | none |
| 7 | M | mining, history, trainer test | none |
| 8 | L | worktree sandbox, report | none |
| 9 | L | vision hand-off, diff check | none |
| 10 | M | triggers, monitors | none |
| 11 | M | suites, history | none |
| 12 | S–M | panels, export | none |

## 7. Risks and limits

See the risk list in the gap analysis. Additionally: several research sources were secondary or blocked; a phase that rests on a blocked source (Phase 6 MCP revision) waits for the host to be allowed; vendor numbers are never used as FRIDAY results; and the Brain cannot be made "smarter than a provider's model" by FRIDAY's code alone, only more reliable around the model the owner chooses, and that is shown only by the benchmark above.

## 8. Recommended first implementation phase

**Phase 1 together with the first step of Phase 2**, in one pull request on an `upgrade/` branch: the model record's `reasoning` and `profile` fields with parity and contract tests, and the answer check loop on the streaming chat with a visible note. Phase 1 alone has no user-visible effect, and Phase 2's chat wiring alone would have no place to read the reasoning control from. Together they are local, CPU-only, need no new dependency, change no workflow, and give the first measurable result: rules kept on the owner's model, before and after, from the Compare run. Start only on the owner's go-ahead.
