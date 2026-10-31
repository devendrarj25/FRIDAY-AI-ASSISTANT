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
| 18 | Evidence-based decisions | PARTIAL | `retrieval.ts` grades retrieval (CRAG-style), `decision-engine.ts`, `core-brain.verify` checks that a cited claim is in the source snippet | citation check is word overlap, not understanding |
| 19 | Uncertainty estimation | DONE | `cognitive-mind.ts` five uncertainty kinds with behaviours (proceed, retrieve, clarify, observe, withhold) | 1 direct test file |
| 20 | Confidence calibration | PARTIAL | `confidence.ts` weakest-link from the capability matrix (46 test files reach it) | never compared with outcomes (no calibration curve) |
| 21 | Contradiction detection | PARTIAL | `memory-fabric.ts` `meaningsDisagree`, `reconciler.ts` | not across retrieved web sources |
| 22 | Knowledge synthesis | PARTIAL | `knowledge-base.ts`, `knowledge-graph.ts` (200 lines) | graph is small |
| 23 | Problem decomposition | DONE | `task-graph.ts` `planNodes` (list, then, parallel), strategy `decomposition` | dependencies are a chain except parallel groups |
| 24 | Complex problem solving | PARTIAL | task graph with checkpoints, retry, replan | long-horizon reliability unmeasured |
| 25 | Adaptive reasoning | DONE | `cognitive-control.ts` proposes a different mode after a miss; effort follows the route (`reasoningEffortFor`) | none FRIDAY-side |

## B. Advanced thinking engine

| Capability | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Fast path for simple tasks | DONE | `cognitive-route.ts` simple → fast-path; `baseline-responder.ts` answers many asks with no model | none |
| Deep reasoning for hard tasks | DONE | route `deep-reasoning`, `reasoning.ts` modes; the model's own control is sent per model (`reasoningControl` in `electron/model-capabilities.cjs`, `kernel/reasoning_control.py`, 6 + 11 tests) | Ollama `think`, `chat_template_kwargs` and OpenAI `reasoning_effort` are not checked against a live server |
| Multi-perspective analysis | PARTIAL | strategy `debate`; `multi-model.ts` second opinions | only on owner ask or a capability gap |
| Parallel solution exploration | PARTIAL | `selectParallel` in `electron/main.cjs` runs several models; best-of-N not used | no objective chooser except answer checks |
| Hypothesis generation and testing | PARTIAL | see A17 | failures only |
| Planning and replanning | DONE | `task-graph.ts` replan with remaining titles; `cognitive-mind.ts` replanning | none |
| Evidence verification | PARTIAL | `retrieval.ts` grading, `verify` | agreement and source kind are rule-based, not a fact check |
| Self-critique, independent evaluation | PARTIAL | `meta-reasoner.evaluateAnswer`, `answer-checks.ts`, `verified-run.ts`; the streaming chat repairs a counted miss once on the same engine (`planRepair`) | checks cover the rules that can be counted; Auto mode and the Hub still use one call |
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
| Agent communication, shared context | DONE | task steps receive earlier results as labelled data; `AgentMailbox` passes length-capped, scrubbed messages only between agents enrolled in a run and renders them as data; delegation modes and `delegatedAuthority` give a delegate only the overlap of authority (agent-delegation test, 6 tests) | A2A stays deferred (no partner agent) |
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
| Semantic, hybrid, context-aware retrieval | PARTIAL | `retrieval.ts` query expansion, lexical plus bm25Lite, reciprocal-rank fusion, MMR, late interaction, entity and tense fit, Hinglish bridge; `kernel/memory.py` hashed or Chroma | no cross-encoder reranker (optional, needs a model download) |
| Consolidation, duplicates | DONE | `memory-consolidate.ts`, `memoriesSimilar`, `distinct` option | none |
| Contradiction resolution | DONE | `meaningsDisagree`, supersede and archive keep history | none |
| Importance and freshness | DONE | usage and recency in `rankByRetrieval`; staleness in `world-model.ts`; per-fact `validFrom`/`validUntil` (`validityState`) kept out of a current answer and used for a past one (memory-validity-entities and memory-authority tests) | none |
| Temporal memory | DONE | superseded facts stay for historical questions; `temporalIntent` and `recencyWeightFor` rank "now" and "used to" questions differently (retrieval suite, 7 tests) | none |
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
| Latency-aware, quality-aware routing | DONE | per-task-kind stats plus the measured model profile (Compare result per model, `model-profile.ts`) feed `preferred()` | needs the owner to press Compare on his own models before it changes anything |
| Context-window, tool, vision, audio awareness | DONE | capability keys in `model-capabilities.cjs` | none |
| Structured output, streaming compatibility | PARTIAL | streaming is handled; structured-output support is not a capability key | add key |
| Fallbacks, health, cooldown | DONE | `model-registry.ts` coolingDown, `pickHealthyModelId` | none |
| Benchmarking, performance history | DONE | `intelligence-benchmark.ts`, Compare run kept per model, suite history in `eval-suites.ts` | none |
| Secure credentials | DONE | Electron `safeStorage` | none |
| Model collaboration A researches, B analyses, C verifies | PARTIAL | `multi-model.ts` + `reconciler.ts`, owner-triggered or gap-triggered | role assignment is not by measured strength |

## F. Continuous learning

| Capability | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Learning from corrections, feedback, outcomes | DONE | `learning-engine.ts`, correction detection, verified-only promotion | none |
| Failed-task analysis | DONE | `error-intelligence.ts`, `limitation-loop.ts`, and `failure-patterns.ts` groups repeated task failures by fingerprint, files each once for review (4 tests) | trend view across weeks is a list |
| Skill discovery, evaluation, versions, rollback | DONE | `skill-loop.ts` (credit, screening, versions, rollback) | none |
| Learning history, feedback analysis | PARTIAL | experiences and skill versions stored | no trend view |
| Performance comparison | DONE | eval harness before and after; Compare run and suite history stored over time | trend is a list, not a graph |
| User-controlled memory settings | DONE | Settings → memory controls (`settings-runtime.ts`) | none |
| Distinguish memory updates from weight training | DONE | `finetune.ts` states adapters only, governed, per run | wording audit in Phase 7 |
| Local adapter training | PARTIAL | `finetune.ts`, `electron/finetune.cjs`, `kernel/finetune_lora.py`; its guards are tested with stand-in libraries (5 tests) | a real training run is unverified here (needs torch, a base model and time) |

## G. Self-improvement and self-development

| Capability | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Identify weaknesses, recurring failures | PARTIAL | `limitation-loop.ts`, `mastery.ts`, capability matrix | no trace mining across runs |
| Improvement proposals | DONE | `governance.ts` discovered → approval, `own-work.ts` | none |
| Isolated branches, run tests, benchmark before and after | PARTIAL | `kernel/dev_check.py` behind exec-tier `dev.check` (diff on a throwaway worktree of HEAD, one fixed check before and after, protected files refused, 12 tests); `devCheckRequest` / `devCheckAllows` build the exact call and read the verdict without ever running it | the owner approves each run; nothing runs it automatically |
| Security analysis of a change | PARTIAL | `own-work.proposeDiff` blocks protected files; `error-intelligence.scanRisks` | not applied to every proposal |
| Authorization, apply, rollback | DONE | governance gate, backup, undo journal | none |
| Never rewrite security rules silently | DONE | `PROTECTED_POLICY_FILES`, always-ask `code-change` | none |

## H. Research and knowledge intelligence

| Capability | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Web research, multi-source | PARTIAL | `research.ts` (27 test files reach it), `browser-engine.ts` | depth and parallel sources limited |
| Research planning, project tracking, reports | PARTIAL | autonomous research on the idle cycle; Hub | no research-project object or report builder |
| Source reliability, fact verification | PARTIAL | `web-sources.ts` classes a result (official, documentation, repository, reference, news, forum, unknown), notes agreeing sites; `research.ts` ranks with it (9 tests) | fact checking itself is the model's |
| Citation management | PARTIAL | `core-brain.verify` requires a cited URL when sources were retrieved and checks the claim against the snippet (`checkCitations`) | snippet only; a page that was not fetched is not read |
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
| Video understanding | PARTIAL | `media.probe` facts, `media.frames` stills, `media.transcribe` words; `video-method.ts` plans the steps, finds video files in a request, notes the method in the turn and builds a labelled-data evidence block (6 tests) | the model joins the parts; no single sound-and-picture pass |
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
| Deadline awareness, opportunity identification | DONE | `extractDeadline` in intake, `trackGoalDeadline` turns a goal's deadline into a desk task, and the desk gives a heads-up an hour before and the reminder at the time (goal-deadlines and owner-work tests) | opportunity identification is not built |
| Proactive suggestions within permissions | DONE | `atlas-notices.ts` throttled notices, governance queue | none |
| Resource-aware scheduling | DONE | idle grace, `admitResources`, and `idleWorkAllowed` holds the heavy idle pass on a low battery or when the owner asked to pause on battery (2 tests) | no CPU-load reading |

## Summary count

| Group | DONE | PARTIAL | MISSING | MODEL | Rows |
| --- | --- | --- | --- | --- | --- |
| A Core cognitive intelligence | 5 | 10 | 0 | 10 | 25 |
| B Advanced thinking engine | 4 | 7 | 0 | 0 | 11 |
| C Autonomous agent intelligence | 4 | 6 | 0 | 0 | 10 |
| D Advanced memory intelligence | 13 | 3 | 0 | 0 | 16 |
| E Multi-model intelligence fusion | 10 | 2 | 0 | 0 | 12 |
| F Continuous learning | 6 | 2 | 0 | 0 | 8 |
| G Self-improvement and self-development | 3 | 3 | 0 | 0 | 6 |
| H Research and knowledge intelligence | 0 | 7 | 0 | 0 | 7 |
| I Universal tool and capability intelligence | 5 | 1 | 0 | 0 | 6 |
| J Multimodal intelligence | 3 | 3 | 1 | 0 | 7 |
| K Computer and environment autonomy | 3 | 1 | 0 | 0 | 4 |
| L Metacognition and self-awareness | 3 | 1 | 0 | 0 | 4 |
| M Proactive and long-term intelligence | 4 | 2 | 0 | 0 | 6 |
| **All** | 63 | 48 | 1 | 10 | 122 |

This table counts rows, not units of intelligence. It is the checklist the roadmap works from, and each phase re-marks the rows it changes with the test that proves it.
