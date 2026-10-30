# FRIDAY — Brain Gap Analysis

_FRIDAY - AI ASSISTANT. A Private, Autonomous and Self Learning OS Based on Local & Cloud Models._

What FRIDAY's Brain already has, what is partial, missing, outdated or duplicated, what should and should not be integrated, and what each gap needs to be closed. Written 2026-10-30 from the audit in [FRIDAY_BRAIN_CAPABILITY_MATRIX.md](FRIDAY_BRAIN_CAPABILITY_MATRIX.md) and the research in [FRIDAY_BRAIN_INTELLIGENCE_RESEARCH.md](FRIDAY_BRAIN_INTELLIGENCE_RESEARCH.md). The first audit counted 122 rows: 52 DONE, 56 PARTIAL, 4 MISSING and 10 that are the model's own ability. After the build described in the status section below the same rows count 58 DONE, 53 PARTIAL, 1 MISSING and 10 model. The counts are recomputed from the rows in the matrix.

## 0. Status after the build

Closed in code, with tests, on this branch: provider reasoning control (record, effort per route, request field per provider), repair of a counted miss on the streaming chat, a measured model profile used when ranking, time-aware and Hinglish-aware retrieval, web source kind and citation check, shared context between task steps, retrieval, routing and long-horizon suites with pass-k and history, the Brain now panel, the `dev.check` sandbox, `media.transcribe`, the deadline heads-up and the trainer's guards. Still open: a cross-encoder reranker (optional download), message passing between agents and A2A, calling `dev.check` automatically on every proposal, a single sound-and-picture pass, realtime multimodal, and a real fine-tuning run. Every provider field not checked against a live server is listed in `FRIDAY_STATE.md`.

Two claims in the first audit were wrong and are corrected below: the retrieval already had a lexical index, fusion, MMR and entity folding (what was missing was time and tense awareness and a Hinglish bridge), and the streaming chat already had a repair stage (what was missing was a check on the counted rules and a same-engine retry before moving to another engine).

## 1. Already strong (do not rebuild)

- **Memory governance**: six tiers, supersede and archive, provenance, privacy, consolidation, ranked forgetting.
- **Routing under firewalls**: free-first model router, billing and privacy firewalls, health and cooldown, capability records with a stated source for every claim.
- **Durable work**: task graph with checkpoints, bounded retry, quarantine, resume that never repeats a side effect, abort, parallel groups.
- **Authority and governance**: kernel-minted single-use tokens, approval gate, undo journal, protected files, always-ask self-changes.
- **Self-knowledge**: Self Atlas, world model, goal stack, uncertainty kinds with behaviours.
- **Measurement basics**: offline eval (85 tasks including held-out), instruction-keeping comparison on the owner's model, per-domain capability matrix.

## 2. Partial: built, narrower than the brief

| Gap | What exists | What is missing | Evidence |
| --- | --- | --- | --- |
| Provider reasoning control (closed in code, see the status section) | strategy modes chosen by FRIDAY; now the model's own control too | live-server checks of the Ollama, vLLM and OpenAI fields | the first audit found no `enable_thinking`, `reasoning_effort`, `budget_tokens` or adaptive-thinking setting anywhere; `kernel/reasoning_control.py` now writes them |
| Verification on the live path | `answer-checks`, `verified-run`, `core-brain.verify`; the streaming chat repairs a counted miss on the same engine, then another | Auto mode and the Hub still call one model once | `planRepair` in `brain-engine.ts` |
| Retrieval quality | query expansion, lexical plus bm25Lite, fusion, MMR, late interaction, entity folding; now also time and tense fit and a Hinglish bridge; hashed n-gram or Chroma vectors | cross-encoder reranker (optional) | `kernel/memory.py`, `retrieval.ts` |
| Per-model measured profile | per-task-kind run, ok, ms per model; capability records | pass rate, latency and cost per model kept over time and used to rank | `coreBrain.state.models` only |
| Agent runtime | 99 agent folders, router, scheduler | agents inspect and plan; shared context and handoffs; measured advantage per specialist | `agent-scheduler.ts` header |
| Research | live search, CRAG-style grading, cited URL required | source reliability, citation correctness, research projects and reports | `research.ts`, `core-brain.verify` |
| Calibration | weakest-link confidence | confidence compared with real outcomes | `confidence.ts` |
| Evaluation breadth | form, error diagnosis, localisation, safe fix, refusal, injection, format questions | tool selection, routing quality, long-horizon, memory retrieval, cost, latency, pass-k reliability | `eval-harness.ts` classes |
| Self-development sandbox | proposals through governance | automatic branch, test and benchmark of a proposal before approval | `own-work.ts` |
| Multimodal | stills from video, OCR, vision role, speech | video with sound in one pass, realtime multimodal | `media.frames`, `modality.ts` |
| Proactive | idle cycle, notices | event triggers, deadline monitor, load and battery awareness | `autonomous-core.ts` |
| Fine-tuning | governed adapter training | a test of the trainer | `kernel/finetune_lora.py` has none |

## 3. Missing

1. Agent-to-agent shared context and message passing (and any A2A interoperability).
2. (Now built as `web-sources.ts`: kinds and agreement, not fact checking.)
3. (Now built as the `dev.check` tool; not yet called automatically on every proposal.)
4. Realtime multimodal interaction.

## 4. Outdated or at risk of going stale

| Item | Why | Action |
| --- | --- | --- |
| Hard-coded thinking behaviour | Claude's manual token budget is deprecated and rejected by 4.7 and later; Qwen3 and DeepSeek-R1 each need different handling | per-model `reasoning` field (Phase 4) |
| MCP revision | the repository snapshot is dated 2026-07-28, newer than the secondary sources; the changelog host was blocked | compare FRIDAY's pinned version with the live spec once readable |
| Model family list in docs | families change every few months | the registry, not prose, is the source; docs name no model as best |
| Memory benchmark numbers from vendors | vendor claims on their managed platform | not used |

## 5. Duplicated or overlapping

These are overlaps to resolve by consolidation inside the existing files. None is a reason to add a new system.

| Overlap | Files | Proposal |
| --- | --- | --- |
| Three "cognitive" modules | `cognitive-control.ts` (363 lines), `cognitive-mind.ts` (960), `cognitive-runtime.ts` (545); the last two have one direct test file each | keep all three, document which contract each owns in the architecture, add contract tests before touching them (Phase 1). Do not merge blindly. |
| Four memory-shaped modules | `memory-engine.ts`, `memory-fabric.ts`, `knowledge-base.ts`, `vector-index.ts` | already designed as one authority plus projections (`memory-fabric.ts` header); confirm with a test that no path reads a projection as authority (Phase 3) |
| Three evaluation modules | `intelligence-benchmark.ts`, `eval-harness.ts`, `instruction-eval.ts` | one evaluation owner with suites, a shared report shape and stored history (Phase 11) |
| Router logic in two languages | `electron/model-router.cjs` (authoritative) and `kernel/router.py` (executes chosen ids) | stays as is, documented; do not copy scoring into Python |
| Registry for models in two places | `electron/model-capabilities.cjs` and `src/lib/friday/brain/model-registry.ts` | renderer view over the main-process record; add a parity test (Phase 4) |

## 6. What to integrate, adapt, and not integrate

| Idea | Decision | Reason |
| --- | --- | --- |
| Provider reasoning controls through one adapter | integrate | closes the largest functional gap; small and testable |
| Check-fix-escalate on chat | integrate | already built and tested |
| Pass-k reliability and fault-labelled failures (τ-bench idea) | adapt | measure repeated runs and classify failures by who is at fault and what type |
| Entity and recency fusion, optional cross-encoder | adapt | local, optional, offline-capable |
| Handoff versus agent-as-tool, per-step trace, checkpoint | adapt into `task-graph.ts` | the common primitives; no framework |
| OpenTelemetry-shaped trace export | adapt | standard tooling can read it; off by default; local file |
| A2A | defer | no partner agent exists; revisit when an outside agent is needed |
| LangGraph, CrewAI, ADK, Microsoft Agent Framework, OpenAI Agents SDK | do not integrate | second runtime, second approval model |
| Learned router | do not integrate | weak generalisation in the reviewed sources |
| Any benchmark that needs a data-centre | do not run | SWE-bench-scale hardware |
| Cloning a model's abilities | impossible | weights and private training data cannot be transferred |

## 7. What each closing step needs

| Need | Gaps it applies to |
| --- | --- |
| **Fully local, CPU only** | answer checks on chat, pass-k evaluation with stub models, entity and recency retrieval, trace export, event triggers, calibration, source-reliability rules, agent shared context, contract tests |
| **Local with a model the owner already runs** | per-model measured profile (needs real calls), reranker (small model download), Compare history |
| **External model API (owner's keys, both firewalls)** | provider reasoning controls on cloud models, multi-model collaboration trials, cloud vision for video frames |
| **GPU** | none required. Local adapter training is the only GPU-hungry feature and is optional and approval-gated |
| **Separate infrastructure** | none proposed. A hosted trace viewer or vector database service is rejected |
| **Owner authorisation** | any `.github/workflows` change, any version bump, any apply of a self-change (governance), MCP revision change, paid-model use, network hosts to read the blocked docs |

## 8. Risks created by closing the gaps

- **More model calls**: retries and second opinions cost money and time. Mitigation: only when a deterministic check fails or the gap rule fires; cost shown; cost-policy still decides.
- **False confidence from checks**: a form check passing does not make an answer true. Mitigation: reports say "rules kept", never "correct".
- **Profile drift**: a measured profile goes stale. Mitigation: store count and date, expire, show "not measured".
- **Reasoning content leakage**: keeping reasoning across tool turns means storing it. Mitigation: kept in the turn only, never in memory, never logged.
- **Overfitting the held-out set**: rules added after seeing failures. Mitigation: the held-out set is renewed each round and the first blind figure is the one reported.
