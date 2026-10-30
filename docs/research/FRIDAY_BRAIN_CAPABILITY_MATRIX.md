# FRIDAY — Brain Capability Matrix

_FRIDAY - AI ASSISTANT. A Private, Autonomous and Self Learning OS Based on Local & Cloud Models._

What the Brain has today, against the thirteen capability groups (A to M) of the Brain evolution brief, audited on 2026-10-30 against the repository. A capability is marked by what is proven, not by what files exist.

**Status words**

- **DONE**: implemented in the owner module, wired into the live path, covered by a test that checks the behaviour.
- **PARTIAL**: implemented but narrower than the brief (a part is missing, or it is built but not on the main chat path, or it has no test of the behaviour).
- **MISSING**: no implementation found.
- **MODEL**: the ability is delivered by whichever model answers; FRIDAY supplies context, routing, checks and memory around it and does not implement the reasoning itself. Where FRIDAY adds a measurable check, it is named.

Test counts are the number of test files that name the module (a rough pointer, not coverage). Line counts are from the repository on this date.

## A. Core cognitive intelligence (25 items)

The reasoning itself is the model's. FRIDAY's part is the strategy chosen, the context given, the checks run on the answer and the memory kept. `REASONING_MODES` in `brain/reasoning.ts` lists the strategies she can select: direct, retrieval, decomposition, analogy, causal, constraint, hypothesis, plan-search, simulation, tool-assisted, debate, verification-first, and `cognitive-control.ts` scores at most three per turn.

| # | Capability | Status | Owner and evidence | Gap |
| --- | --- | --- | --- | --- |
| 1 | Contextual intelligence | DONE | `context-engine.ts` budgets and ranks context; `conversation-state.ts`, `topic-state.ts`, `open-loops.ts` | none |
| 2 | Semantic understanding | MODEL | embeddings in `kernel/memory.py` are hashed n-grams offline, Chroma otherwise | stronger local embedding model optional |
| 3 | Intent recognition | DONE | `intent-engine.ts` (27 test files reach it through the brain), correction detection | Hinglish coverage tests are thin |
| 4 | Logical reasoning | MODEL | strategy `constraint`, `verification-first` | no formal check |
| 5 | Analytical reasoning | MODEL | strategies `decomposition`, `retrieval` | none FRIDAY-side |
| 6 | Critical thinking | PARTIAL | `meta-reasoner.ts` lists known, unknown, stale; `evaluateAnswer` | runs on consequential asks only |
| 7 | Abstract reasoning | MODEL | strategy `analogy` | not measured |
| 8 | Causal reasoning | PARTIAL | strategy `causal`; `error-intelligence.ts` ranks causes with evidence for failures | general causal tasks are the model's |
| 9 | Deductive reasoning | MODEL | none | not measured |
| 10 | Inductive reasoning | MODEL | none | not measured |
| 11 | Analogical reasoning | MODEL | strategy `analogy` | not measured |
| 12 | Mathematical reasoning | PARTIAL | `answer-checks.ts` recomputes a plain arithmetic ask with its own evaluator and checks the number | no symbolic or word-problem checker |
| 13 | Scientific reasoning | MODEL | `research.ts` gathers sources | no hypothesis-test harness |
| 14 | Strategic thinking | PARTIAL | `horizon-goals.ts`, goal stack in `cognitive-runtime.ts` | not measured |
| 15 | Creative thinking | MODEL | none FRIDAY-side | not measured |
| 16 | Counterfactual reasoning | MODEL | strategy `simulation` | not measured |
| 17 | Hypothesis generation | PARTIAL | strategy `hypothesis`; `error-intelligence.ts` ranks hypotheses with evidence (36 tests) | failures only |
| 18 | Evidence-based decisions | PARTIAL | `retrieval.ts` grades retrieval (CRAG-style), `decision-engine.ts` | no citation correctness check |
| 19 | Uncertainty estimation | DONE | `cognitive-mind.ts` five uncertainty kinds with behaviours (proceed, retrieve, clarify, observe, withhold) | 1 direct test file |
| 20 | Confidence calibration | PARTIAL | `confidence.ts` weakest-link from the capability matrix (46 test files reach it) | never compared with outcomes (no calibration curve) |
| 21 | Contradiction detection | PARTIAL | `memory-fabric.ts` `meaningsDisagree`, `reconciler.ts` | not across retrieved web sources |
| 22 | Knowledge synthesis | PARTIAL | `knowledge-base.ts`, `knowledge-graph.ts` (200 lines) | graph is small |
| 23 | Problem decomposition | DONE | `task-graph.ts` `planNodes` (list, then, parallel), strategy `decomposition` | dependencies are a chain except parallel groups |
| 24 | Complex problem solving | PARTIAL | task graph with checkpoints, retry, replan | long-horizon reliability unmeasured |
| 25 | Adaptive reasoning | PARTIAL | `cognitive-control.ts` proposes a different mode after a miss | provider thinking controls not sent (see B) |

## B. Advanced thinking engine

| Capability | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Fast path for simple tasks | DONE | `cognitive-route.ts` simple → fast-path; `baseline-responder.ts` answers many asks with no model | none |
| Deep reasoning for hard tasks | PARTIAL | route `deep-reasoning`, `reasoning.ts` modes | the model's own thinking control (effort, `enable_thinking`, budget) is **never sent**; searched `electron/`, `kernel/`, `src/` |
| Multi-perspective analysis | PARTIAL | strategy `debate`; `multi-model.ts` second opinions | only on owner ask or a capability gap |
| Parallel solution exploration | PARTIAL | `selectParallel` in `electron/main.cjs` runs several models; best-of-N not used | no objective chooser except answer checks |
| Hypothesis generation and testing | PARTIAL | see A17 | failures only |
| Planning and replanning | DONE | `task-graph.ts` replan with remaining titles; `cognitive-mind.ts` replanning | none |
| Evidence verification | PARTIAL | `retrieval.ts` grading, `verify` | no source-reliability score |
| Self-critique, independent evaluation | PARTIAL | `meta-reasoner.evaluateAnswer`, `answer-checks.ts`, `verified-run.ts` | loop not on streaming chat or Auto |
| Error correction | DONE | `verified-run.ts` fix once then escalate (9 tests); `error-intelligence.ts` | not on main chat |
| Final synthesis, confidence reporting | PARTIAL | `reconciler.ts`; confidence notes in cognition | not shown per answer |
| Token, time, cost, latency budgets | PARTIAL | `cost-policy.ts` spend rules, `context-engine.ts` token budget, `task-graph` budgets (`budgetBlock`) | no per-turn latency budget that changes the strategy |

## C. Autonomous agent intelligence

| Capability | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Main supervisor retains the result | DONE | `task-graph.ts` owns the run; `core-brain` owns the answer | none |
| Specialist agents (planning, research, coding, analysis, browser, computer-use, memory, verification, testing, docs, automation, business) | PARTIAL | 99 core agent folders plus manifests under `agents/`; `agent-router.ts`; `orchestrator.ts` roles (planner, coder, reviewer, tester, reasoner, vision, audio) | agents **plan and inspect**; they mutate only after approval via `agent-scheduler.ts` (3 test files). No measured advantage per specialist. |
| Dynamic agent selection, delegation | PARTIAL | `agent-router.ts`, `agent-forge.ts` | handoff versus agent-as-tool is not distinguished |
| Parallel execution | PARTIAL | new: pieces of an "at the same time" node run together, capped by `maxConcurrentTasks` (7 tests) | queued graphs still run one after another |
| Agent communication, shared context | MISSING | the ledger is shared; no message passing between agents | Phase 5 |
| Structured outputs | PARTIAL | tool schemas in `kernel/tools.py`; runner results are typed | agent outputs are not schema-validated |
| Supervision, verification, retry, recovery | DONE | `task-graph.ts` bounded retry, quarantine, `failure-guard`, sealed events | none |
| Cancellation, checkpointing, persistence, long-running | DONE | abort signal, `Checkpoint`, persisted graphs, resume rule that never repeats a side effect | none |
| Dependency management | PARTIAL | `dependsOn` per node, but plans are chains | DAG planning |
| Resource allocation | PARTIAL | `admitResources`, `maxConcurrentTasks` | no cost-aware scheduling |

## D. Advanced memory intelligence

| Type or capability | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Working, short-term (temporary), long-term (permanent), episodic, semantic, archived | DONE | six tiers with retention rules in `memory-engine.ts` (916 lines, 22 test files) | none |
| Conversational, session state, task memory | DONE | `conversation-state.ts`, `topic-state.ts`, `task-ledger.ts` | none |
| User preference memory | DONE | `user-profile.ts`, memory kind `preference` | none |
| Project memory | PARTIAL | `project-identity.ts`, `project-workspace-observe.ts` | registered workspaces not yet read roots |
| Procedural memory | DONE | `skill-loop.ts` (versioned, verified-only, 26 tests) | none |
| Experience memory | DONE | `task-ledger.ts` experiences, `learning-engine.ts` | none |
| Associative memory, knowledge graph memory | PARTIAL | `knowledge-graph.ts` 200 lines | small and not queried by retrieval |
| External knowledge memory | DONE | `knowledge-base.ts`, `knowledge-ingest.ts` | none |
| Extraction, classification | DONE | `classifyMemoryKind`, `memory-fabric.ts` | none |
| Semantic, hybrid, context-aware retrieval | PARTIAL | `retrieval.ts` query expansion, fusion, late-interaction without embeddings; `kernel/memory.py` hashed or Chroma | no BM25 index in the vector path, no entity link, no reranker |
| Consolidation, duplicates | DONE | `memory-consolidate.ts`, `memoriesSimilar`, `distinct` option | none |
| Contradiction resolution | DONE | `meaningsDisagree`, supersede and archive keep history | none |
| Importance and freshness | PARTIAL | usage and recency in `rankByRetrieval`; staleness in `world-model.ts` | no per-fact validity period |
| Temporal memory | PARTIAL | superseded facts stay for historical questions | time-aware ranking for "current state" asks is missing |
| Forgetting and retention | DONE | per-tier caps, expiry, ranked forgetting in `cognitive-runtime.ts` | none |
| Provenance and privacy | DONE | `redactForExport`, `secretStaysOutOfMemory`, provenance on skills | none |

## E. Multi-model intelligence fusion

| Capability | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Providers: OpenAI, Anthropic, Gemini, DeepSeek, Mistral, others | DONE | 22 cloud entries in `electron/models.cjs` `CLOUD` (OpenAI, Anthropic, Gemini, Groq, Mistral, Cohere, DeepSeek, NVIDIA, Fireworks, DeepInfra, Cerebras, SambaNova, Moonshot, Zhipu, Hugging Face, Together, xAI, Perplexity, Nebius, OpenRouter and more) | **no direct Alibaba (Qwen) provider**; Qwen and Llama arrive through Ollama, LM Studio, Hugging Face, Together, OpenRouter and similar |
| Local engines: Ollama and compatible servers | DONE | Ollama, LM Studio, llama.cpp, vLLM, LocalAI, Jan, KoboldCpp, GPT4All, transformers | none |
| Dynamic model discovery | DONE | each provider's list endpoint and the Hugging Face search in `models.cjs` | none |
| Capability profiles | DONE | `model-capabilities.cjs` (declared → curated → heuristic, each labelled) | reasoning control and measured profile fields missing |
| Task-based, cost-aware routing | DONE | `electron/model-router.cjs` free-first, billing policy, scoring (35 test files) | none |
| Latency-aware, quality-aware routing | PARTIAL | per-task-kind stats (`coreBrain.state.models` runs, ok, ms) | not used to rank beyond a preference |
| Context-window, tool, vision, audio awareness | DONE | capability keys in `model-capabilities.cjs` | none |
| Structured output, streaming compatibility | PARTIAL | streaming is handled; structured-output support is not a capability key | add key |
| Fallbacks, health, cooldown | DONE | `model-registry.ts` coolingDown, `pickHealthyModelId` | none |
| Benchmarking, performance history | PARTIAL | `intelligence-benchmark.ts`, new Compare run | per-model, not stored over time |
| Secure credentials | DONE | Electron `safeStorage` | none |
| Model collaboration A researches, B analyses, C verifies | PARTIAL | `multi-model.ts` + `reconciler.ts`, owner-triggered or gap-triggered | role assignment is not by measured strength |

## F. Continuous learning

| Capability | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Learning from corrections, feedback, outcomes | DONE | `learning-engine.ts`, correction detection, verified-only promotion | none |
| Failed-task analysis | PARTIAL | `error-intelligence.ts`, `limitation-loop.ts` | not summarised across tasks |
| Skill discovery, evaluation, versions, rollback | DONE | `skill-loop.ts` (credit, screening, versions, rollback) | none |
| Learning history, feedback analysis | PARTIAL | experiences and skill versions stored | no trend view |
| Performance comparison | PARTIAL | eval harness before, after; Compare run | not stored over time |
| User-controlled memory settings | DONE | Settings → memory controls (`settings-runtime.ts`) | none |
| Distinguish memory updates from weight training | DONE | `finetune.ts` states adapters only, governed, per run | wording audit in Phase 7 |
| Local adapter training | PARTIAL | `finetune.ts`, `electron/finetune.cjs`, `kernel/finetune_lora.py` (235 lines) | the Python trainer has **no test**; unverified here |

## G. Self-improvement and self-development

| Capability | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Identify weaknesses, recurring failures | PARTIAL | `limitation-loop.ts`, `mastery.ts`, capability matrix | no trace mining across runs |
| Improvement proposals | DONE | `governance.ts` discovered → approval, `own-work.ts` | none |
| Isolated branches, run tests, benchmark before and after | MISSING | proposals are diffs; no automated branch-and-test sandbox for FRIDAY's own source | Phase 8 |
| Security analysis of a change | PARTIAL | `own-work.proposeDiff` blocks protected files; `error-intelligence.scanRisks` | not applied to every proposal |
| Authorization, apply, rollback | DONE | governance gate, backup, undo journal | none |
| Never rewrite security rules silently | DONE | `PROTECTED_POLICY_FILES`, always-ask `code-change` | none |

## H. Research and knowledge intelligence

| Capability | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Web research, multi-source | PARTIAL | `research.ts` (27 test files reach it), `browser-engine.ts` | depth and parallel sources limited |
| Research planning, project tracking, reports | PARTIAL | autonomous research on the idle cycle; Hub | no research-project object or report builder |
| Source reliability, fact verification | MISSING | none | Phase 6 |
| Citation management | PARTIAL | `core-brain.verify` requires a cited URL when sources were retrieved | no citation correctness check |
| Contradiction analysis | PARTIAL | see A21 | web sources |
| RAG, hybrid search, reranking | PARTIAL | see D | reranker |
| Knowledge freshness | PARTIAL | `world-model.ts` factFreshness, pricing freshness | per-source |

## I. Universal tool and capability intelligence

| Capability | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Discovery, manifests, schemas, descriptions | DONE | `capability-registry.ts` (763 lines, 11 test files), manifests in `agents/`, `skills/`, `tools/`, `plugins/`, `modules/`, `workflows/`, import format | none |
| Compatibility, permissions, health, versions, dependencies | DONE | capability lifecycle record, `capabilityMayRun`, install manager | none |
| Usage analytics, failure handling, retirement | PARTIAL | `mastery.ts` derives from the ledger | retirement flow |
| MCP server and client | DONE | `electron/mcp-protocol.cjs`, off by default, loopback and stdio only | spec revision check pending (changelog host blocked) |
| Tools, skills, plugins, browser, desktop, code, files, databases | DONE | kernel tools (76), `sqlite.query`, `fs.make`, `media.*` | none |
| Never trust an unknown tool | DONE | quarantine in the forges, kernel authority tokens | none |

## J. Multimodal intelligence

| Capability | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Text, document, OCR | DONE | `electron/document-extract.cjs`, `kernel/document_ocr.py`, `fs.extract` | none |
| Image understanding | PARTIAL | `screen-vision.cjs`, vision role in routing | needs a vision-capable model; chat IPC was text-only per `modality.ts` |
| Audio, speech recognition, text-to-speech | DONE | faster-whisper, edge-tts, Supertonic, wake word | real-microphone feel unverified |
| Video understanding | PARTIAL | `media.frames` samples stills; no live video | not joined to sound |
| Image and file generation | PARTIAL | cloud image generation; `fs.make` documents | no local image model |
| Screen understanding | DONE | `screen-observe.ts`, `kernel` UIA | none |
| Real-time multimodal interaction | MISSING | no realtime API integration | Phase 9 |

## K. Computer and environment autonomy

| Capability | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Screen observation, UI understanding, desktop interaction | DONE | `computer-use.ts` (1,206 lines, 4 test files), kernel `input.*`, `screen.*`, UIA | Windows paths unverified |
| Browser navigation | DONE | `browser-engine.ts`, `browser-live.cjs` | none |
| Permission levels, approvals | DONE | autonomy dial, authority tokens | none |
| Visual verification, recovery, action history | PARTIAL | `computer-use.ts` halts and receipts | no screenshot-diff verification |

## L. Metacognition and self-awareness

| Capability | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Task, objective, information held and missing | DONE | `cognitive-runtime.ts` goal stack and self-model, `meta-reasoner.ts` | none |
| Tools, active model, permissions, constraints | DONE | `self-atlas.ts`, `world-model.ts`, autonomy and governance state | none |
| Successes, failures, confidence | PARTIAL | ledger and receipts; confidence not calibrated | calibration |
| When to ask for help | DONE | `decision-engine.ts` ask and confirm routes | none |

## M. Proactive and long-term intelligence

| Capability | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Goal management, persistent continuation | DONE | `horizon-goals.ts`, persisted graphs, resume | none |
| Project monitoring, scheduled and event tasks | PARTIAL | `autonomous-core.ts` idle cycle, `agent-scheduler.ts`; no event triggers beyond notifications | event rules |
| Background research | PARTIAL | idle research cycle | bounded depth |
| Deadline awareness, opportunity identification | PARTIAL | `extractDeadline` in intake | no deadline monitor |
| Proactive suggestions within permissions | DONE | `atlas-notices.ts` throttled notices, governance queue | none |
| Resource-aware scheduling | PARTIAL | idle grace, `admitResources` | no battery or load awareness |

## Summary count

| Group | DONE | PARTIAL | MISSING | MODEL | Rows |
| --- | --- | --- | --- | --- | --- |
| A Core cognitive intelligence | 4 | 11 | 0 | 10 | 25 |
| B Advanced thinking engine | 3 | 8 | 0 | 0 | 11 |
| C Autonomous agent intelligence | 3 | 6 | 1 | 0 | 10 |
| D Advanced memory intelligence | 11 | 5 | 0 | 0 | 16 |
| E Multi-model intelligence fusion | 8 | 4 | 0 | 0 | 12 |
| F Continuous learning | 4 | 4 | 0 | 0 | 8 |
| G Self-improvement and self-development | 3 | 2 | 1 | 0 | 6 |
| H Research and knowledge intelligence | 0 | 6 | 1 | 0 | 7 |
| I Universal tool and capability intelligence | 5 | 1 | 0 | 0 | 6 |
| J Multimodal intelligence | 3 | 3 | 1 | 0 | 7 |
| K Computer and environment autonomy | 3 | 1 | 0 | 0 | 4 |
| L Metacognition and self-awareness | 3 | 1 | 0 | 0 | 4 |
| M Proactive and long-term intelligence | 2 | 4 | 0 | 0 | 6 |
| **All** | 52 | 56 | 4 | 10 | 122 |

This table counts rows, not units of intelligence. It is the checklist the roadmap works from, and each phase re-marks the rows it changes with the test that proves it.
