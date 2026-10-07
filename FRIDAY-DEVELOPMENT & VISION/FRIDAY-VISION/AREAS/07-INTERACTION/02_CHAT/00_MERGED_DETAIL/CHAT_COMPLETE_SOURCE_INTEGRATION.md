# Chat — Complete Detailed Architecture Integration

This is an integrated preservation of the detailed source architecture from the supplied package. The content is merged into the unified FRIDAY interaction architecture; it is not a separate runtime or competing source of truth.

## Integration rule

- Preserve every requirement and behavioral rule below.
- Resolve ownership through the current FRIDAY Brain/System/Capability/Task/Governance owners.
- If a source document names a component that conflicts with current ownership, treat the named component as a responsibility, not permission to create a duplicate subsystem.

## Integrated source documents


---

# SOURCE: `00_START/00_READ_FIRST.md`


# FRIDAY Chat / Manual Mode — GOD MODE Final Architecture Package

**Scope:** Chat / Manual Mode only. Voice runtime, voice architecture, home automation runtime, device fleet architecture, and general FRIDAY system redesign are explicitly out of scope.

This package is the final implementation-grade architecture/specification handoff for the current FRIDAY checkout supplied on 2026-09-14. It supersedes the earlier `FRIDAY-CHAT-MANUAL-DEEP-UPGRADE` handoff as the deeper planning baseline.

## Non-negotiable intent
- One FRIDAY brain; Chat is a modality/surface, never a second brain.
- Typed/manual input and text/visual/artifact output. No normal TTS path.
- Reuse the live registries and routers already present.
- Make every chat capability discoverable through the existing single-source-of-truth pattern.
- Add smart routing, fallback, health, retry, recovery, verification, cancellation, stale-result protection, durable task continuation, context budgeting, and truthful status.
- Keep UI/design/build/installer/release behavior unchanged unless a proven runtime dependency makes a change unavoidable.
- Do not add a second scheduler, second memory, second model registry, second capability registry, or parallel execution engine.

## Golden rule
**INSPECT → UNDERSTAND → MODIFY ONLY WHAT IS REQUIRED → INTEGRATE → TEST → REGRESSION-TEST → CONFIRM.**

This is an architecture and implementation plan package. It does not modify the FRIDAY source checkout.


---

# SOURCE: `00_START/01_PACKAGE_MAP.md`


# Package Map

1. `01_SCOPE` — exact Chat/Manual boundary and definition of done.
2. `02_CURRENT_STATE` — current checkout audit and gap map.
3. `03_RESEARCH` — current external patterns and source index.
4. `04_ARCHITECTURE` — target architecture, ownership and invariants.
5. `05_PIPELINE` — complete turn lifecycle, streaming, recovery and verification.
6. `06_ROUTING` — unified capability resolution and fallback system for models, skills, tools, plugins, modules, workflows, agents, connectors, browser, PC/device/external systems.
7. `07_COMPONENTS` — component-level contracts and responsibilities.
8. `08_RUNTIME` — IPC, persistence, resource scheduling, local/cloud model execution and realtime performance.
9. `09_CONTRACTS` — JSON schemas and event/idempotency contracts.
10. `10_IMPLEMENTATION` — source-oriented file map and phased execution plan.
11. `11_ACCEPTANCE` — minimum tests and failure/recovery matrix.
12. `12_HANDOFF` — master prompt and repair protocol.
13. `13_DIAGRAMS` — source-independent SVG flow diagrams.


---

# SOURCE: `01_SCOPE/01_CHAT_MODE_BOUNDARY.md`


# Chat / Manual Mode Boundary

Chat Mode owns:
- typed user turns;
- supported file/attachment input;
- conversation/session continuity;
- text generation and streaming;
- visual presentation and artifacts already supported by FRIDAY;
- planning, routing, tool/capability invocation and verification when initiated by chat;
- task handoff to the existing durable task graph;
- chat-visible progress and background-to-chat notifications;
- memory recall/write through the existing memory owners;
- model/provider selection through the existing model registry;
- truthful recovery/fallback and user-facing error composition.

Chat Mode does **not** own:
- wake word;
- microphone capture as its normal input path;
- TTS/speech output;
- voice session state;
- a new home-device architecture;
- a new PC-control architecture;
- a new browser architecture;
- a new plugin/connector runtime;
- a new scheduler.

Those capabilities may be invoked by Chat through their existing authoritative owners. Chat supplies the request; the existing subsystem remains the executor.


---

# SOURCE: `01_SCOPE/02_NON_GOALS.md`


# Non-goals

Do not redesign the visual UI. Do not rewrite working registries. Do not replace Electron IPC, kernel tools, model providers, connector runtime, task graph, memory engine, browser engine or governance gate merely to make the architecture look cleaner.

Do not add LangGraph, AutoGen, Temporal, Qdrant, OpenTelemetry or another framework by default. They are reference patterns or optional integrations only when a measured gap justifies them. The existing FRIDAY runtime remains authoritative.

Do not make Chat Mode report “connected”, “installed”, “working”, “verified” or “completed” from model text alone.


---

# SOURCE: `01_SCOPE/03_DEFINITION_OF_DONE.md`


# Definition of Done

A Chat/Manual upgrade is complete only when all of the following are true:

1. Every typed turn has stable `conversationId`, `turnId`, `generationId` and optional `taskId` correlation.
2. A turn can be cancelled and its stale async results can never overwrite a newer generation.
3. Chat progress is event-driven and renderer-friendly; long work survives renderer reload/restart through the existing task/checkpoint owners.
4. Context is assembled under a bounded budget and preserves decisions, constraints, open loops and verified results during compaction.
5. Capability routing is registry-driven and can choose among models, skills, tools, plugins, modules, workflows, agents, connectors and existing system/browser/device capabilities.
6. Fallback decisions distinguish safe read/retry operations from uncertain side effects.
7. Provider/resource health is measured and decays/recoveries are persisted through existing health state; no fake “online” badges.
8. Tool results are observed and verified before a success claim.
9. Memory writes use provenance/policy and do not turn every transcript into permanent memory.
10. Background/self-learning/self-development/self-evolution work continues without Chat becoming its scheduler, but yields to foreground interaction.
11. No normal Manual Mode path invokes TTS.
12. Existing UI, build, installer and release paths remain unchanged unless a proven dependency requires otherwise.
13. Targeted tests and real build/typecheck evidence are executed in the available environment before claiming completion.


---

# SOURCE: `02_CURRENT_STATE/01_CHECKOUT_AUDIT.md`


# Current Checkout Audit — 2026-09-14

Supplied source: `FRIDAY-AI-ASSISTANT-main(4).zip`

Archive integrity: valid (`ZipFile.testzip() == None`).

Observed package metadata: `package.json` npm version 1.0.0 (FRIDAY's own authoritative app identity is the 4-part version in `config/friday-version.json`, e.g. `1.0.0.2` — the two are intentionally different fields; see `AGENTS.md`), Electron 43.6.0, React 19.2, Vite 8.2.2, TypeScript 5.9.3, Vitest 4.1.11. The project is Windows-first and has explicit build/installer/release scripts that must be preserved.

The source contains a substantial existing brain/runtime rather than a blank Chat implementation. Important live owners include `brain-engine.ts`, `brain/*`, `model-registry.ts`, `model-catalog.ts`, `models-engine.ts`, `capability-registry.ts`, `task-graph.ts`, `background-tasks.ts`, `memory-engine.ts`, Electron model/tool/capability runtimes and kernel tools.

The feature catalog reports large installed capability inventories (skills/tools/agents/plugins/workflows/modules/connectors). Therefore the correct upgrade is orchestration and reliability around the existing capability surface, not duplication of those catalogs.


---

# SOURCE: `02_CURRENT_STATE/02_CHAT_DOCK_AUDIT.md`


# ChatDock Audit

`src/components/friday/ChatDock.tsx` is large (~1328 lines in the supplied checkout) and currently owns UI/session presentation, streaming subscription, attachments, model/capability controls and some local session persistence.

The architectural rule for the upgrade is to keep ChatDock as a presentation/controller surface. It must not become the source of truth for task execution, provider health, approvals, long-running work or durable state.

The textarea should remain responsive by avoiding per-keystroke rebuilding of the entire tree. Existing optimizations in the file should be preserved.

Manual-mode dictation, if retained, is an input convenience only: it ends as text and must not route the response through TTS.


---

# SOURCE: `02_CURRENT_STATE/03_EXISTING_LIVE_OWNERS.md`


# Existing Live Owners

## Conversation/brain
- `src/lib/friday/brain-engine.ts`
- `src/lib/friday/brain/core-brain.ts`
- `src/lib/friday/brain/context-engine.ts`
- `src/lib/friday/brain/intent-engine.ts`
- `src/lib/friday/brain/decision-engine.ts`
- `src/lib/friday/brain/orchestrator.ts`
- `src/lib/friday/brain/conversation-state.ts`
- `src/lib/friday/brain/open-loops.ts`
- `src/lib/friday/brain/topic-state.ts`

## Routing
- `capability-registry.ts`
- `model-registry.ts`
- `tool-router.ts`
- `skill-router.ts`
- `workflow-router.ts`
- `connector-router.ts`
- `agent-router.ts`
- `module-router.ts`
- `model-routing-contract.ts`

## Execution/authority
- Electron model/tool/capability runtimes
- `electron/tool-authority.cjs`
- `electron/sandbox*.cjs`
- `kernel/tools.py`
- existing approval/governance/action-risk path

## Durable/background
- `self/task-graph.ts`
- `self/task-ledger.ts`
- `self/task-runners.ts`
- `self/background-tasks.ts`
- `self/agent-scheduler.ts`

## Memory/knowledge
- `self/memory-engine.ts`
- `self/memory-consolidate.ts`
- `self/memory-teach.ts`
- `brain/retrieval.ts`
- `brain/vector-index.ts`
- `brain/knowledge-base.ts`
- `brain/knowledge-graph.ts`

## Model/provider
- `model-catalog.ts`
- `models-engine.ts`
- `model-registry.ts`
- Electron model dispatch
- `kernel/router.py`

## Presentation/observability
- `ChatDock.tsx`
- turn trace/timing
- doctor/network/log streams
- existing artifact/presentation components


---

# SOURCE: `02_CURRENT_STATE/04_EXISTING_ROUTER_GAPS.md`


# Existing Router Gap Map

The checkout already has separate routers for tools, skills, workflows, connectors, agents and modules and a central capability registry. This is good separation of execution adapters, but Chat needs a **single resolution protocol above them**.

Required improvement is not to merge all routers into one giant file. Instead add a thin shared resolver/orchestrator that:

1. queries the authoritative capability registry;
2. asks each existing router for candidates;
3. normalizes candidate evidence into one `CapabilityCandidate` contract;
4. ranks candidates using intent fit + health + permissions + latency + cost + measured reliability + user constraints;
5. constructs an ordered fallback plan;
6. executes one candidate at a time unless parallelism is explicitly safe;
7. stops fallback when an uncertain side effect may already have happened;
8. records the real outcome back into the existing health/trace/task owners.

This avoids a second registry while giving Chat a coherent routing brain.


---

# SOURCE: `02_CURRENT_STATE/05_CURRENT_FALLBACK_STATUS.md`


# Existing Fallback Strengths and Missing Guarantees

Already present:
- model cooldown/health concepts;
- provider probes;
- local/cloud model catalog;
- browser search fallback wording;
- capability health fields;
- router-level candidate scoring;
- task graph interruption/resume;
- doctor/self-diagnosis infrastructure.

Still required for a futureproof Chat contract:
- one normalized fallback decision model across every resource type;
- explicit retryability/idempotency classification per capability call;
- circuit-breaker state independent of a single UI component;
- bounded exponential backoff with jitter;
- provider/model failure taxonomy;
- stale-generation suppression across all async paths;
- “unknown outcome” state for timeouts after side-effect submission;
- fallback budget so a broken request cannot fan out indefinitely;
- recovery/replan rules that preserve verified work;
- health score decay and recovery probes;
- evidence-backed completion contract.


---

# SOURCE: `02_CURRENT_STATE/06_EXISTING_TESTING_REALITY.md`


# Testing Reality

The supplied project contains extensive `core/__tests__` contracts in the repository documentation, while the simple source scan shows only a small number of renderer-local `*.test.*` files. The implementation pass must use the project's existing test commands and contracts rather than inventing a second test system.

Because the supplied archive is a source snapshot, environment prerequisites must be checked before any claim of build success. In particular, the project package declares Node >=22.19.0; a runtime with an older Node must not be reported as a successful build environment.


---

# SOURCE: `02_CURRENT_STATE/07_ARCHITECTURAL_RISKS.md`


# Architectural Risks

1. **ChatDock over-ownership:** renderer state can accidentally become task truth.
2. **Split routing:** individual routers can make locally correct decisions that are globally suboptimal.
3. **Fallback duplication:** a mutation may execute and then be repeated on a fallback provider after a timeout.
4. **Unbounded context:** raw transcript growth increases latency and can dilute critical constraints.
5. **Background contention:** idle work can consume CPU/RAM/network while an interactive turn is waiting.
6. **False success:** model prose can look successful even when a tool failed.
7. **Stale streams:** a previous generation can append tokens to a newer turn after cancellation.
8. **Renderer dependency:** long-running work can disappear on reload if it lives only in an IPC handler.
9. **Capability drift:** catalog metadata may say available while the live endpoint is unhealthy.
10. **Over-frameworking:** importing a large orchestration framework can duplicate existing FRIDAY infrastructure.


---

# SOURCE: `03_RESEARCH/01_RESEARCH_DECISIONS.md`


# Research Decisions

## Adopt
- durable state/checkpoints for long-running work;
- explicit plan → act → observe → verify loops;
- human approval as a durable gate;
- event-driven progress with correlation IDs;
- provider/resource health and per-operation retry policy;
- bounded context with summary/decision preservation;
- hybrid semantic + lexical retrieval where retrieval quality justifies it;
- standard MCP boundary for tools/data and A2A boundary for remote agents when actually needed;
- vendor-neutral traces/metrics/logs for diagnostics.

## Do not automatically adopt
- a second agent framework;
- a second workflow engine;
- a hosted vector database;
- a second scheduler;
- a second memory store.

The current FRIDAY runtime already supplies these responsibilities. External projects are reference patterns and optional adapters, not replacements.


---

# SOURCE: `03_RESEARCH/02_OPENAI_AGENT_PATTERNS.md`


# OpenAI Agent Patterns

The current OpenAI agent guidance emphasizes models + tools + instructions/guardrails, while newer Agents SDK work adds configurable memory, sandbox-aware orchestration, filesystem/system tools and long-horizon execution.

FRIDAY implication: Chat should treat tool access, memory, governance and execution as first-class runtime concerns around the model rather than making the model itself the whole assistant.

Reference: https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/
Reference: https://openai.com/index/the-next-evolution-of-the-agents-sdk/


---

# SOURCE: `03_RESEARCH/03_DURABLE_EXECUTION_PATTERNS.md`


# Durable Execution Patterns

Temporal's AI reference architecture separates deterministic orchestration from nondeterministic I/O: LLM calls, tool calls, external APIs and database reads are treated as activities/side effects. It also demonstrates durable human-in-the-loop gates, queued user messages, per-tool retry policy and conversation-history compaction.

FRIDAY implication: the existing task graph/checkpoint system should be the durability boundary. The chat turn controller should persist enough state to resume after renderer/app interruption without replaying uncertain side effects.

References:
- https://go.temporal.io/platform-hub/ai-engineering/ai-reference-architecture
- https://go.temporal.io/platform-hub/ai-engineering


---

# SOURCE: `03_RESEARCH/04_LANGGRAPH_PATTERNS.md`


# LangGraph Patterns

Current LangGraph documentation exposes explicit durability modes for graph state (`sync`, `async`, `exit`). The useful architectural idea for FRIDAY is not the framework itself but making persistence timing an intentional policy.

FRIDAY implication: checkpoints should be synchronous before irreversible transitions and can be asynchronous around safe streaming/progress where latency matters.

Reference: https://reference.langchain.com/python/langgraph/types/Durability


---

# SOURCE: `03_RESEARCH/05_MCP_A2A.md`


# MCP and A2A

MCP is the tool/data boundary. A2A is the agent-to-agent boundary. A2A 1.0 defines discovery, Agent Cards, stateful tasks and structured message/artifact parts.

FRIDAY implication:
- existing tools/connectors/plugins remain local authoritative capabilities;
- MCP adapters can expose/consume standardized external tools/resources;
- A2A is an optional edge adapter for delegating to remote/local agents;
- neither protocol becomes a replacement for FRIDAY's internal capability registry.

References:
- https://modelcontextprotocol.io/
- https://a2a-protocol.org/v1.0.0/
- https://a2a-protocol.org/latest/topics/key-concepts/


---

# SOURCE: `03_RESEARCH/06_RETRIEVAL.md`


# Retrieval Research

Qdrant's current documentation recommends hybrid search patterns combining dense semantic retrieval with sparse lexical retrieval and multi-stage reranking. The important lesson is that semantic similarity and exact identifiers solve different retrieval failures.

FRIDAY implication: preserve the current retrieval/vector owners and add hybrid retrieval only where measurements show exact identifiers, filenames, code symbols or configuration tokens are being missed by semantic search alone.

References:
- https://qdrant.tech/documentation/search/text-search/hybrid-search/
- https://qdrant.tech/documentation/search/hybrid-queries/


---

# SOURCE: `03_RESEARCH/07_OBSERVABILITY.md`


# Observability Research

OpenTelemetry provides vendor-neutral traces, metrics and logs with shared context. Its signal model is a useful fit for correlation IDs across Chat → router → model/tool → verification.

FRIDAY implication: instrument the existing runtime without making telemetry a hard dependency for chat correctness. Local ring-buffer logs and existing Doctor/Logs remain the minimum fallback if no exporter is configured.

References:
- https://opentelemetry.io/docs/
- https://opentelemetry.io/docs/concepts/signals/


---

# SOURCE: `03_RESEARCH/08_RESILIENCE_PATTERNS.md`


# Resilience Patterns

Use these proven concepts:
- timeout budgets;
- exponential backoff + jitter;
- circuit breakers/cooldowns;
- bulkhead/resource budgets;
- idempotency keys;
- hedging only for safe, read-only, latency-sensitive operations;
- stale-result suppression;
- unknown-outcome states after ambiguous timeouts;
- evidence-based verification.

Do not blindly retry writes, purchases, sends, deletes, installs or system mutations.


---

# SOURCE: `03_RESEARCH/09_SOURCE_INDEX.md`


# Research Source Index

| Area | Source |
|---|---|
| Agent design | https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/ |
| Long-horizon agent harness | https://openai.com/index/the-next-evolution-of-the-agents-sdk/ |
| Durable agent architecture | https://go.temporal.io/platform-hub/ai-engineering/ai-reference-architecture |
| AI engineering patterns | https://go.temporal.io/platform-hub/ai-engineering |
| LangGraph durability | https://reference.langchain.com/python/langgraph/types/Durability |
| MCP | https://modelcontextprotocol.io/ |
| A2A 1.0 | https://a2a-protocol.org/v1.0.0/ |
| A2A key concepts | https://a2a-protocol.org/latest/topics/key-concepts/ |
| OpenTelemetry | https://opentelemetry.io/docs/ |
| Qdrant hybrid search | https://qdrant.tech/documentation/search/text-search/hybrid-search/ |


---

# SOURCE: `04_ARCHITECTURE/01_SYSTEM_ARCHITECTURE.md`


# Target Chat Architecture

```text
Typed Input
  ↓
Chat Surface
  ↓
Turn Gateway
  ↓
Normalization + Attachment Intake
  ↓
Session / Conversation State
  ↓
Context Budget + Retrieval
  ↓
Intent + Request Classification
  ↓
Cognitive Orchestrator
  ↓
Capability Resolution
  ↓
Unified Fallback Planner
  ↓
Governance / Approval
  ↓
Execution Runtime
  ↓
Observation
  ↓
Verification
  ↓
Memory / Learning Candidate
  ↓
Response Composition
  ↓
Presentation / Artifacts
  ↓
Chat Surface
```

For multi-step work, the central loop is:

`UNDERSTAND → PLAN → GOVERN → EXECUTE → OBSERVE → VERIFY → REPLAN/CONTINUE → RESPOND`.

The loop is durable at task boundaries and interruptible at every safe checkpoint.


---

# SOURCE: `04_ARCHITECTURE/02_OWNERSHIP_BOUNDARIES.md`


# Ownership Boundaries

| Concern | Owner | Chat responsibility |
|---|---|---|
| UI | ChatDock/components | render state; send typed intent |
| turn identity | new turn controller over existing brain runtime | create IDs, lifecycle |
| brain | brain-engine/core-brain | orchestrate, never duplicate |
| context | context-engine/conversation-state/retrieval | request bounded context |
| models | model-registry/models-engine/Electron/kernel | resolve/execute |
| capabilities | capability-registry + existing routers | candidate discovery |
| execution | Electron/kernel/runtime owners | execute real calls |
| approval | existing governance/action-risk | gate unsafe actions |
| tasks | task-graph/ledger/runners | durable long work |
| memory | memory-engine/retrieval/knowledge owners | recall/write candidates |
| background | background-tasks/autonomous owners | continue/yield |
| health | existing model/provider/doctor/network state | consume evidence |
| artifacts | existing presentation/artifact owners | render references |

No new owner may duplicate a row above.


---

# SOURCE: `04_ARCHITECTURE/03_EVENT_DRIVEN_RUNTIME.md`


# Event-Driven Runtime

Every chat lifecycle event carries:
- `conversationId`
- `turnId`
- `generationId`
- optional `taskId`
- monotonic sequence number
- timestamp
- event type
- safe payload

Minimum events:
`turn.accepted`, `turn.context_ready`, `turn.intent_ready`, `turn.plan_ready`, `approval.required`, `approval.resolved`, `capability.started`, `capability.progress`, `capability.completed`, `capability.failed`, `verification.completed`, `memory.candidate`, `task.checkpointed`, `task.paused`, `task.resumed`, `task.cancelled`, `response.delta`, `artifact.created`, `turn.completed`, `turn.failed`.

The renderer subscribes; it does not poll task truth.


---

# SOURCE: `04_ARCHITECTURE/04_DURABILITY_AND_RESTART.md`


# Durability and Restart

A normal short chat turn may remain in the active brain runtime. Any operation crossing the long-running threshold or containing multiple external side effects is promoted to the existing task graph.

Checkpoint before:
- external mutation;
- approval wait;
- expensive multi-step transition;
- provider handoff after an uncertain boundary;
- renderer-independent continuation.

On restart:
1. restore task ledger/checkpoints;
2. reconcile in-flight calls as `unknown` when outcome is ambiguous;
3. verify before retrying;
4. resume only from the last verified checkpoint;
5. rehydrate Chat UI from task/turn state.


---

# SOURCE: `04_ARCHITECTURE/05_CONCURRENCY_MODEL.md`


# Concurrency Model

Interactive foreground work has priority. Safe independent read operations may run concurrently. Mutations remain serialized by the existing authority/approval model.

Use a per-turn concurrency budget:
- one primary generation;
- bounded parallel retrieval;
- bounded parallel read-only tool calls;
- one active mutation chain per governed resource;
- global resource governor for CPU/RAM/GPU/network.

Background jobs yield when foreground pressure rises.


---

# SOURCE: `04_ARCHITECTURE/06_CONTEXT_BUDGET.md`


# Context Budget

Context assembly is a budget allocator, not a transcript dump.

Priority order:
1. current user turn;
2. explicit current constraints;
3. pending approval/task state;
4. verified results from this task;
5. active conversation goal/decisions/open loops;
6. relevant long-term memories with provenance;
7. recent conversation summary;
8. optional background knowledge.

Never compact away the constraint that makes an action safe or the evidence that proves a prior step succeeded.


---

# SOURCE: `04_ARCHITECTURE/07_MEMORY_LIFETIMES.md`


# Memory Lifetimes

1. **Turn state:** ephemeral execution details; exact inputs/results.
2. **Conversation state:** active goal, decisions, references, commitments, corrections, open loops.
3. **Long-term memory:** only policy-approved, useful, provenance-bearing facts/preferences/lessons.
4. **Knowledge:** source-backed documents/data in the existing retrieval/knowledge system.

A chat response is not automatically a memory. A tool result is not automatically a permanent fact.


---

# SOURCE: `04_ARCHITECTURE/08_MANUAL_MODALITY.md`


# Manual Modality Contract

Manual Mode input: typed text and supported attachments. Optional dictation is an input helper only.

Manual Mode output: text, structured data, images/charts/artifacts already supported by the existing presentation surface.

Manual Mode must never implicitly call TTS, wake-word, microphone-output or voice-session ownership.


---

# SOURCE: `04_ARCHITECTURE/09_BACKGROUND_INTERACTION.md`


# Background Interaction

Self-learning, self-development, self-evolution and background tasks are existing FRIDAY capabilities. Chat Mode does not implement them; it exposes their state and receives their relevant events.

When a background task needs the owner's attention, publish a chat-visible event. Do not interrupt an active response unless the existing notification policy says it is urgent.

When foreground chat begins, idle work should yield according to the existing scheduler/resource policy.


---

# SOURCE: `04_ARCHITECTURE/10_ARCHITECTURE_INVARIANTS.md`


# Architecture Invariants

- one brain;
- one capability registry;
- one model registry;
- one task graph;
- one governance gate;
- one memory authority;
- one authoritative result per side effect;
- no hidden renderer-owned truth;
- no success without evidence;
- no unsafe automatic retry;
- no fallback after uncertain mutation without reconciliation;
- no UI redesign as part of backend reliability work.


---

# SOURCE: `05_PIPELINE/01_TURN_GATEWAY.md`


# Turn Gateway

Accept typed input, create IDs, deduplicate submission, enforce modality, establish cancellation scope and emit accepted/rejected events.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/02_INPUT_NORMALIZATION.md`


# Input Normalization

Normalize text, attachments, command syntax, locale/time references and explicit user constraints without losing original content.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/03_SESSION_REHYDRATION.md`


# Session Rehydration

Restore conversation/task state after reload or restart and reconcile pending work before accepting dependent actions.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/04_CONTEXT_ASSEMBLY.md`


# Context Assembly

Use bounded budgets, active conversation state, retrieval and verified task evidence. Never dump all history.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/05_INTENT_UNDERSTANDING.md`


# Intent Understanding

Produce structured intent, entities, constraints and uncertainty; do not expose hidden chain-of-thought.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/06_REQUEST_CLASSIFICATION.md`


# Request Classification

Classify answer-only, retrieval, tool use, multi-step task, governed mutation, background handoff, clarification or refusal.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/07_PLANNING.md`


# Planning

Create an executable plan with dependencies, expected outputs, verification conditions, risk class and fallback policy.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/08_CAPABILITY_RESOLUTION.md`


# Capability Resolution

Query the shared capability registry and existing routers, normalize candidates and rank them using live evidence.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/09_FALLBACK_PLANNING.md`


# Fallback Planning

Build an ordered fallback chain with retry budget, timeout budget, circuit state, idempotency class and unknown-outcome handling.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/10_GOVERNANCE.md`


# Governance

Run every action through existing permission/action-risk/approval rules. Approval is durable and resumable.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/11_EXECUTION.md`


# Execution

Invoke the existing model/tool/connector/browser/kernel/runtime owners through their supported contracts.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/12_OBSERVATION.md`


# Observation

Capture real outputs, exit status, response metadata, side effects, files changed and provider/tool evidence.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/13_VERIFICATION.md`


# Verification

Check postconditions independently of model prose. Return verified, failed or unknown—not optimistic success.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/14_MEMORY_LEARNING.md`


# Memory and Learning

Generate policy-filtered memory candidates and lessons; persist only useful/provenance-bearing state.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/15_RESPONSE_COMPOSITION.md`


# Response Composition

Turn verified outcomes into concise, truthful chat response plus progress summary and artifact references.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/16_PRESENTATION.md`


# Visual Presentation

Use existing chat/artifact presentation contracts; never let UI become execution truth.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/17_STREAMING.md`


# Streaming Lifecycle

Stream progress and safe model deltas with generation checks, backpressure and terminal events.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/18_CANCELLATION.md`


# Cancellation

Propagate cancellation from turn to task/capability/provider; distinguish cancelled from failed and from unknown outcome.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/19_RECOVERY_REPLAN.md`


# Recovery and Replanning

Repair transient failures, swap candidates when safe, preserve verified work and ask the owner when ambiguity affects side effects.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/20_COMPLETION.md`


# Completion

Close stages, record timings, health outcome, memory candidates, task checkpoint and final response; emit exactly one terminal turn event.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/21_ERROR_TAXONOMY.md`


# Error Taxonomy

Normalize timeout, rate-limit, auth, unavailable, malformed, policy, dependency, cancellation and unknown-outcome failures.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/22_PARALLELISM.md`


# Parallelism

Run only independent, read-only operations concurrently and merge results deterministically.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/23_PROGRESS.md`


# Progress UX Contract

Separate acknowledgement, planning, tool progress, model streaming, verification and final answer so the user never waits on a silent spinner.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `05_PIPELINE/24_RESULT_REUSE.md`


# Verified Result Reuse

Reuse recent verified results when freshness and scope allow; never repeat expensive or mutating work unnecessarily.

## Required contract
- Every step receives correlation IDs.
- Every external call returns a structured outcome.
- Every step is cancellable where technically possible.
- Every failure is classified before retry/fallback.
- Every success that matters has verification evidence.


---

# SOURCE: `06_ROUTING/01_UNIFIED_CAPABILITY_RESOLVER.md`


# Unified Capability Resolver

Thin orchestration layer over the existing capability registry and specialized routers. It does discovery, normalization, scoring and fallback-plan creation—not execution.

## Design rule
Never create a parallel catalog just to support this feature. Candidate facts must originate in existing registries/manifests/live probes and be normalized at the resolver boundary.


---

# SOURCE: `06_ROUTING/02_MODEL_ROUTING.md`


# Model Routing

Use model-registry live availability, task fit, measured reliability, latency, cost, context limits and provider health. Preserve manual picks while still enforcing safety and fallback semantics.

## Design rule
Never create a parallel catalog just to support this feature. Candidate facts must originate in existing registries/manifests/live probes and be normalized at the resolver boundary.


---

# SOURCE: `06_ROUTING/03_SKILL_ROUTING.md`


# Skill Routing

Reuse skill-router. Add capability evidence, version/health and fallback metadata at the resolver boundary.

## Design rule
Never create a parallel catalog just to support this feature. Candidate facts must originate in existing registries/manifests/live probes and be normalized at the resolver boundary.


---

# SOURCE: `06_ROUTING/04_TOOL_ROUTING.md`


# Tool Routing

Reuse tool-router. Classify tools by read-only, reversible write, irreversible mutation and unknown outcome risk.

## Design rule
Never create a parallel catalog just to support this feature. Candidate facts must originate in existing registries/manifests/live probes and be normalized at the resolver boundary.


---

# SOURCE: `06_ROUTING/05_PLUGIN_ROUTING.md`


# Plugin Routing

Treat plugins as lifecycle/integration capabilities. Health-check before invocation; do not duplicate plugin registration.

## Design rule
Never create a parallel catalog just to support this feature. Candidate facts must originate in existing registries/manifests/live probes and be normalized at the resolver boundary.


---

# SOURCE: `06_ROUTING/06_MODULE_ROUTING.md`


# Module Routing

Reuse module-router and live manifests. Candidate selection is registry-driven and execution remains in the module runtime.

## Design rule
Never create a parallel catalog just to support this feature. Candidate facts must originate in existing registries/manifests/live probes and be normalized at the resolver boundary.


---

# SOURCE: `06_ROUTING/07_WORKFLOW_ROUTING.md`


# Workflow Routing

Use workflow-router for declared multi-step workflows. Resolver checks whether the workflow is safe to run automatically or must pass governance.

## Design rule
Never create a parallel catalog just to support this feature. Candidate facts must originate in existing registries/manifests/live probes and be normalized at the resolver boundary.


---

# SOURCE: `06_ROUTING/08_AGENT_ROUTING.md`


# Agent Routing

Use agent-router for specialist delegation. A2A can be an adapter for remote agents; local FRIDAY agent registry remains authoritative for installed agents.

## Design rule
Never create a parallel catalog just to support this feature. Candidate facts must originate in existing registries/manifests/live probes and be normalized at the resolver boundary.


---

# SOURCE: `06_ROUTING/09_CONNECTOR_ROUTING.md`


# Connector Routing

Use connector-router. OAuth/API health, scopes, freshness and permissions become candidate evidence. External connectors never bypass governance.

## Design rule
Never create a parallel catalog just to support this feature. Candidate facts must originate in existing registries/manifests/live probes and be normalized at the resolver boundary.


---

# SOURCE: `06_ROUTING/10_BROWSER_PC_DEVICE_ROUTING.md`


# Browser / PC / Device Routing

Chat resolves existing browser, terminal, sandbox, PC control and device capabilities through the same resolver. Their execution owners remain unchanged.

## Design rule
Never create a parallel catalog just to support this feature. Candidate facts must originate in existing registries/manifests/live probes and be normalized at the resolver boundary.


---

# SOURCE: `06_ROUTING/11_MCP_API_EXTERNAL_ROUTING.md`


# MCP / API / External Routing

MCP is a standardized edge for tools/resources; direct APIs remain supported; external systems get health, auth, timeout and schema evidence.

## Design rule
Never create a parallel catalog just to support this feature. Candidate facts must originate in existing registries/manifests/live probes and be normalized at the resolver boundary.


---

# SOURCE: `06_ROUTING/12_FALLBACK_ENGINE.md`


# Fallback Engine

A shared policy engine decides retry vs alternate candidate vs replan vs user clarification. It prevents unsafe repeat side effects.

## Design rule
Never create a parallel catalog just to support this feature. Candidate facts must originate in existing registries/manifests/live probes and be normalized at the resolver boundary.


---

# SOURCE: `06_ROUTING/13_HEALTH_CIRCUIT_BREAKER.md`


# Health and Circuit Breaker

Maintain candidate state: healthy, degraded, open-circuit, half-open probe, unavailable, unknown. Cooldowns are evidence-driven and recover via probes.

## Design rule
Never create a parallel catalog just to support this feature. Candidate facts must originate in existing registries/manifests/live probes and be normalized at the resolver boundary.


---

# SOURCE: `06_ROUTING/14_RETRY_IDEMPOTENCY.md`


# Retry and Idempotency

Every capability declares retry class. Safe reads can retry. Idempotent writes require an idempotency key. Ambiguous writes become unknown until reconciled.

## Design rule
Never create a parallel catalog just to support this feature. Candidate facts must originate in existing registries/manifests/live probes and be normalized at the resolver boundary.


---

# SOURCE: `06_ROUTING/15_ROUTING_SCORE.md`


# Routing Score

Recommended weighted score: intent fit 30%, health/reliability 20%, latency 15%, capability completeness 15%, policy/permission fit 10%, cost 5%, freshness 5%. Weights are policy, not hardcoded forever.

## Design rule
Never create a parallel catalog just to support this feature. Candidate facts must originate in existing registries/manifests/live probes and be normalized at the resolver boundary.


---

# SOURCE: `07_COMPONENTS/01_chat_surface.md`


# Chat Surface

ChatDock remains UI/presentation; it sends turns and renders lifecycle events.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/02_turn_controller.md`


# Turn Controller

Own turn/generation identity, cancellation, terminal state and stale-result rejection.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/03_context_manager.md`


# Context Manager

Budget and prioritize context; preserve constraints and verified results.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/04_intent_classifier.md`


# Intent Classifier

Structured intent and uncertainty, no hidden reasoning exposure.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/05_plan_engine.md`


# Plan Engine

Executable plans, dependencies, risk and verification conditions.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/06_capability_bus.md`


# Capability Bus

Normalized candidate contract over existing routers.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/07_fallback_engine.md`


# Fallback Engine

Retry/fallback/replan policy.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/08_provider_health.md`


# Provider Health

Live health, cooldowns, circuit state and recovery probes.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/09_execution_runtime.md`


# Execution Runtime

Calls existing Electron/kernel/runtime owners and records outcomes.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/10_observation_engine.md`


# Observation Engine

Real evidence capture.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/11_verification_engine.md`


# Verification Engine

Independent postcondition verification.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/12_task_bridge.md`


# Task Bridge

Promote long-running work to task graph and rehydrate it.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/13_memory_fabric.md`


# Memory Fabric

Policy-filtered memory candidates and retrieval.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/14_response_composer.md`


# Response Composer

Truthful response from verified state.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/15_event_bus.md`


# Event Bus

Ordered lifecycle events with correlation and sequence.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/16_stream_manager.md`


# Stream Manager

Delta streaming, backpressure, terminal semantics.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/17_resource_governor.md`


# Resource Governor

Foreground priority and background yielding.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/18_artifact_bridge.md`


# Artifact Bridge

References existing artifact/presentation owners.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/19_error_runtime.md`


# Error Runtime

Normalize and route failure classes.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/20_observability.md`


# Observability

Turn/capability/provider telemetry with existing logs/Doctor and optional OTel.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/21_session_rehydration.md`


# Session Rehydration

Restore UI and durable work state.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/22_background_bridge.md`


# Background Bridge

Deliver relevant background events into chat without taking over scheduling.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/23_learning_bridge.md`


# Learning Bridge

Expose learning/self-development/evolution outcomes while keeping their owners unchanged.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/24_attachment_intake.md`


# Attachment Intake

Hash, classify, parse and route attachments through existing file/knowledge owners.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/25_security_boundary.md`


# Security Boundary

Capability permissions, sandbox, tool authority and governance remain authoritative.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/26_completion_guard.md`


# Completion Guard

Ensures one terminal state and evidence-backed success.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/27_cache_result_reuse.md`


# Result Reuse Cache

Short-lived verified-result references, freshness and scope checks.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/28_context_compactor.md`


# Context Compactor

Summarize while preserving constraints/decisions/open loops/evidence.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/29_recovery_coordinator.md`


# Recovery Coordinator

Coordinates retry, alternate candidate, replan and user escalation.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `07_COMPONENTS/30_manual_mode_guard.md`


# Manual Mode Guard

Prevents accidental voice output/session ownership from chat path.

## Inputs
Structured turn state, live registry facts and policy.

## Outputs
Structured state/events; never UI-only truth.

## Must not do
Create duplicate subsystem ownership or bypass governance.


---

# SOURCE: `08_RUNTIME/01_RUNTIME_TOPOLOGY.md`


# Runtime Topology

Renderer ChatDock → existing IPC → main/Electron runtime → kernel/local/cloud providers; durable work via existing task graph.

## Principle
Prefer existing FRIDAY infrastructure. Introduce a new dependency only when a measurable capability gap cannot be solved locally without unacceptable complexity.


---

# SOURCE: `08_RUNTIME/02_IPC_CONTRACT.md`


# IPC Contract

Use correlation IDs, typed payloads, ordered lifecycle events, cancellation and terminal acknowledgement.

## Principle
Prefer existing FRIDAY infrastructure. Introduce a new dependency only when a measurable capability gap cannot be solved locally without unacceptable complexity.


---

# SOURCE: `08_RUNTIME/03_STORAGE.md`


# Storage

Reuse existing persist/task ledger/memory stores. Add only schema fields required for turn/generation/checkpoint semantics.

## Principle
Prefer existing FRIDAY infrastructure. Introduce a new dependency only when a measurable capability gap cannot be solved locally without unacceptable complexity.


---

# SOURCE: `08_RUNTIME/04_MODEL_RUNTIME.md`


# Model Runtime

Local engines and cloud providers are selected from live registry; provider adapter owns request/stream/error normalization.

## Principle
Prefer existing FRIDAY infrastructure. Introduce a new dependency only when a measurable capability gap cannot be solved locally without unacceptable complexity.


---

# SOURCE: `08_RUNTIME/05_LOCAL_ACCELERATION.md`


# Local Acceleration

Use existing local model detection and Windows acceleration; ONNX Runtime/WinML is optional only for measured auxiliary inference needs.

## Principle
Prefer existing FRIDAY infrastructure. Introduce a new dependency only when a measurable capability gap cannot be solved locally without unacceptable complexity.


---

# SOURCE: `08_RUNTIME/06_RESOURCE_BUDGETS.md`


# Resource Budgets

Foreground latency budget, background yield, per-call timeouts, global concurrency and memory caps.

## Principle
Prefer existing FRIDAY infrastructure. Introduce a new dependency only when a measurable capability gap cannot be solved locally without unacceptable complexity.


---

# SOURCE: `08_RUNTIME/07_REALTIME_PERFORMANCE.md`


# Realtime Performance

Targets: input acknowledgement <100ms, first useful progress <200ms, first useful text target around 1s on healthy low-latency routes, cancellation acknowledgement <200ms. Measure; do not promise.

## Principle
Prefer existing FRIDAY infrastructure. Introduce a new dependency only when a measurable capability gap cannot be solved locally without unacceptable complexity.


---

# SOURCE: `08_RUNTIME/08_BACKPRESSURE.md`


# Backpressure

Coalesce progress, cap buffered deltas, prioritize terminal events and keep renderer responsive.

## Principle
Prefer existing FRIDAY infrastructure. Introduce a new dependency only when a measurable capability gap cannot be solved locally without unacceptable complexity.


---

# SOURCE: `08_RUNTIME/09_NETWORK_PROVIDER_RECOVERY.md`


# Network/Provider Recovery

Offline mode, rate limits, auth failures, provider outages and recovery probes with truthful state.

## Principle
Prefer existing FRIDAY infrastructure. Introduce a new dependency only when a measurable capability gap cannot be solved locally without unacceptable complexity.


---

# SOURCE: `08_RUNTIME/10_WINDOWS_RUNTIME.md`


# Windows Runtime

Preserve Electron/Windows process model, IPC, sandbox and installer assumptions. No packaging redesign.

## Principle
Prefer existing FRIDAY infrastructure. Introduce a new dependency only when a measurable capability gap cannot be solved locally without unacceptable complexity.


---

# SOURCE: `09_CONTRACTS/01_EVENT_CATALOG.md`


# Event Catalog

Terminal event is exactly one of `turn.completed`, `turn.failed`, `turn.cancelled`.

Progress events must be safe to replay. Every event is scoped by generation ID so stale streams are ignored.

Never stream hidden chain-of-thought. Stream user-safe status, tool names where appropriate, progress, outputs and final text—not private reasoning traces.


---

# SOURCE: `09_CONTRACTS/02_IDEMPOTENCY.md`


# Idempotency Rules

- Safe read: retryable with bounded backoff.
- Idempotent write: retry only with a stable idempotency key or verified duplicate suppression.
- Non-idempotent write: no automatic retry after timeout until outcome is reconciled.
- Unknown outcome: do not fallback to another mutating provider until the first side effect is reconciled.
- Model generation: safe to retry before a side effect, but do not replay tool mutations merely because generation failed.


---

# SOURCE: `09_CONTRACTS/03_FAILURE_CODES.md`


# Failure Codes

`AUTH`, `RATE_LIMIT`, `OFFLINE`, `TIMEOUT`, `NETWORK`, `BAD_REQUEST`, `SCHEMA`, `TOOL_ERROR`, `PROVIDER_ERROR`, `POLICY`, `APPROVAL_REQUIRED`, `CANCELLED`, `RESOURCE_LIMIT`, `DEPENDENCY`, `UNKNOWN_OUTCOME`, `VERIFICATION_FAILED`.

Each code maps to retryability, cooldown, fallback and user-message policy.


---

# SOURCE: `09_CONTRACTS/04_HEALTH_STATE.md`


# Health State

A capability has both **availability** and **health**. Availability says whether it can be selected. Health says whether it should be trusted now.

Recommended states: `ready`, `degraded`, `open-circuit`, `half-open`, `offline`, `unknown`.


---

# SOURCE: `09_CONTRACTS/05_RESPONSE_TRUTH.md`


# Response Truth Contract

A final response may say:
- completed only when verification is `verified`;
- failed when verification is `failed`;
- still working when a durable task remains active;
- needs approval when a governed action is blocked;
- outcome uncertain when a side effect cannot yet be reconciled.

The model cannot override this contract.


---

# SOURCE: `10_IMPLEMENTATION/01_FILE_BY_FILE_MAP.md`


# File-by-File Implementation Map

## Primary touch points
- `src/components/friday/ChatDock.tsx` — presentation/controller integration only.
- `src/lib/friday/brain-engine.ts` — turn orchestration integration; preserve existing behavior.
- `src/lib/friday/brain/context-engine.ts` — bounded context integration.
- `src/lib/friday/brain/conversation-state.ts` — turn/goal/open-loop persistence integration.
- `src/lib/friday/brain/orchestrator.ts` — plan/execute/observe/verify coordination.
- `src/lib/friday/brain/capability-registry.ts` — consume/extend live resource facts only.
- `src/lib/friday/brain/model-registry.ts` — model health/routing evidence.
- existing specialized routers — candidate discovery only; avoid rewrites.
- `src/lib/friday/self/task-graph.ts` / ledger / runners — durable task bridge.
- `src/lib/friday/self/background-tasks.ts` — foreground priority hooks only if required.
- existing persistence/runtime/Electron IPC modules — typed lifecycle and cancellation wiring.

## New modules only if the inspected code proves there is no owner
Potential names are descriptive, not mandatory. Before creating any file, search for equivalent functionality and extend it instead.


---

# SOURCE: `10_IMPLEMENTATION/02_PHASED_EXECUTION.md`


# Phased Execution

### Phase 0 — inspect and baseline
Run dependency/environment checks, typecheck/test baselines and architecture/duplicate checks.

### Phase 1 — lifecycle foundation
Implement typed turn/generation IDs, cancellation, stale-result suppression and event lifecycle.

### Phase 2 — unified capability resolution
Normalize candidate evidence over the existing routers and registry. No new catalogs.

### Phase 3 — resilience
Add retry taxonomy, idempotency classification, circuit/cooldown policy, fallback budget and unknown-outcome reconciliation.

### Phase 4 — context + memory
Add bounded context and verified-result reuse while preserving current memory owners.

### Phase 5 — durable tasks
Bridge complex turns into the existing task graph and support renderer rehydration.

### Phase 6 — response/presentation
Wire lifecycle state into existing ChatDock presentation without redesign.

### Phase 7 — verification
Run targeted tests, typecheck, build and relevant install/release smoke checks only as permitted by environment and scope.


---

# SOURCE: `10_IMPLEMENTATION/03_DO_NOT_TOUCH.md`


# Do Not Touch Unless Proven Necessary

- installer/packaging scripts;
- CI/CD and release workflows;
- versioning/release identity;
- existing visual design/layout;
- unrelated voice runtime;
- unrelated home/device architecture;
- existing capability manifests/catalogs;
- existing governance/approval implementation.


---

# SOURCE: `10_IMPLEMENTATION/04_MIGRATION_SAFETY.md`


# Migration Safety

Prefer additive fields and adapters over destructive schema rewrites. Keep old event consumers working while the new lifecycle events are introduced. Persist new fields with safe defaults. Never delete legacy state until a real migration/recovery path exists.


---

# SOURCE: `10_IMPLEMENTATION/05_DEPENDENCY_RULES.md`


# Dependency Rules

1. Existing implementation beats a new library.
2. Standard protocol beats custom integration when interoperability is actually needed.
3. Small utility beats a framework.
4. New runtime dependency requires measured need, license check, packaging proof and rollback path.
5. Build/release files are frozen unless the dependency cannot work without them.


---

# SOURCE: `10_IMPLEMENTATION/06_IMPLEMENTATION_CHECKLIST.md`


# Implementation Checklist

- [ ] inspect current source before every edit
- [ ] locate existing owner before adding code
- [ ] add correlation IDs
- [ ] add event lifecycle
- [ ] add stale generation protection
- [ ] add cancellation
- [ ] normalize capability candidates
- [ ] add fallback policy
- [ ] classify retry/idempotency
- [ ] verify side effects
- [ ] persist long tasks
- [ ] rehydrate after restart
- [ ] bound context
- [ ] preserve background scheduling ownership
- [ ] preserve Manual Mode no-TTS contract
- [ ] run targeted tests
- [ ] run typecheck/build evidence
- [ ] update authoritative docs only


---

# SOURCE: `11_ACCEPTANCE/01_ACCEPTANCE_MATRIX.md`


# Acceptance Matrix

| Area | Must prove |
|---|---|
| Chat input | typed turn accepted quickly and exactly once |
| Streaming | deltas arrive in order; stale generation ignored |
| Cancel | cancellation reaches active operation and terminal event emitted |
| Model fallback | unhealthy model is skipped/retired and alternate selected safely |
| Tool fallback | read failure can retry/alternate; mutation timeout becomes unknown |
| Governance | dangerous action cannot bypass approval |
| Verification | false-success tool response is rejected |
| Context | long chat remains bounded and preserves constraints |
| Task durability | reload/restart resumes from checkpoint |
| Background | foreground chat preempts/yields idle work |
| Memory | only policy-approved candidates persist |
| Manual mode | no TTS/wake-word path |
| Regression | existing build/install/release flows remain intact |


---

# SOURCE: `11_ACCEPTANCE/02_FAILURE_MATRIX.md`


# Failure / Recovery Matrix

| Failure | Action |
|---|---|
| provider 429 | cooldown + alternate healthy candidate |
| auth 401 | mark unavailable; do not retry blindly |
| network timeout before send | safe retry with backoff |
| network timeout after uncertain write | unknown outcome; reconcile |
| malformed model output | schema repair/retry if no side effect; otherwise replan |
| tool unavailable | alternate capability or explain missing dependency |
| approval rejected | stop governed branch, preserve conversation |
| renderer reload | rehydrate from runtime/task state |
| process crash | recover durable task from checkpoint |
| stale stream | discard by generation ID |
| verification failure | do not claim success; repair/replan |


---

# SOURCE: `11_ACCEPTANCE/03_PERFORMANCE.md`


# Performance Targets

Engineering targets, measured rather than promised:
- input acknowledgement <100ms on healthy local runtime;
- first useful progress <200ms;
- first useful text target around 1s on healthy low-latency route;
- cancellation acknowledgement <200ms;
- no visible UI freeze from background work;
- bounded event buffer and bounded context assembly.

Measure p50/p95/p99 for turn acceptance, first progress, first token, tool latency, final verification and cancellation.


---

# SOURCE: `11_ACCEPTANCE/04_REGRESSION.md`


# Regression Checklist

Run the project's existing test/build commands. At minimum cover:
- chat send/stream/stop;
- model selection/routing;
- provider health/fallback;
- tool/skill/workflow/connector routing;
- approval flow;
- task pause/resume/cancel;
- memory continuity;
- browser/PC capability invocation;
- renderer reload;
- packaged desktop startup;
- installer/packaging only if touched or required by the runtime change.


---

# SOURCE: `11_ACCEPTANCE/05_REAL_EVIDENCE.md`


# Evidence Rule

Never write “fixed”, “connected”, “installed”, “working” or “verified” without an actual execution result. If the environment prevents a full check, report the exact blocker and do not substitute static inspection for runtime evidence.


---

# SOURCE: `12_HANDOFF/01_MASTER_CURSOR_PROMPT.md`


# Master Implementation Prompt — FRIDAY Chat/Manual GOD MODE

You are implementing the Chat/Manual Mode upgrade in the existing FRIDAY Windows desktop project.

Follow exactly: **INSPECT → UNDERSTAND → MODIFY ONLY WHAT IS REQUIRED → INTEGRATE → TEST → REGRESSION-TEST → CONFIRM.**

Before editing, inspect the latest checkout, the existing ChatDock, brain engine, all existing routers, capability/model registries, task graph, memory owners, Electron IPC and governance. Do not assume this package is newer than source.

Implement the architecture in this package using the existing owners. Do not create ChatBrain, ChatTaskManager, ChatModelRegistry, ChatMemory, ChatScheduler or parallel capability catalogs.

Manual Mode accepts typed text/attachments and produces text/visual/artifact output. Do not add TTS/wake-word/microphone output to this path.

Every turn must have conversationId/turnId/generationId. Add event-driven progress, cancellation propagation and stale-result rejection. Complex work must use the existing durable task graph. Renderer reload must not destroy task truth.

Build one normalized capability resolution layer above the existing specialized routers. Candidate evidence must include availability, health, measured reliability, latency, capability fit, permission, cost, retry class and streaming/cancellation support. Produce a bounded fallback plan.

Retry only operations classified as safe. Never automatically repeat an uncertain side effect. If a mutation times out after submission may have occurred, mark the outcome unknown and reconcile before fallback.

Verify real postconditions before success claims. The model is not proof.

Keep context bounded. Preserve active constraints, decisions, open loops and verified results during compaction. Do not store every turn as long-term memory.

Foreground chat gets latency priority; existing background/self-learning/self-development/self-evolution scheduling remains the owner of background work.

Do not redesign UI. Do not touch build/installer/release unless a proven dependency requires it. If a required change touches them, stop and explain before making it.

Run real targeted tests and the strongest feasible build/typecheck evidence. Never claim completion without evidence.


---

# SOURCE: `12_HANDOFF/02_COMPONENT_PROMPT.md`


# Component Prompt Template

For each component:
1. identify the current owner;
2. inspect imports and callers;
3. state the exact gap;
4. modify only the owner or the smallest integration seam;
5. preserve public behavior;
6. add the minimum test proving the gap;
7. run targeted regression;
8. update the one authoritative documentation location.

Reject duplicate registries, UI redesign, hidden fallback, unsafe retry and model-generated success claims.


---

# SOURCE: `12_HANDOFF/03_REPAIR_PROMPT.md`


# Repair Prompt

When Chat is broken after implementation:

INSPECT the failing trace/event sequence and the owning module. Identify whether the failure is lifecycle, routing, health, execution, verification, persistence, IPC or presentation.

Repair the smallest owner. Do not patch symptoms in ChatDock if the source of truth is the brain/runtime. Re-run the exact failing scenario, then the smallest relevant regression set. Do not change unrelated systems.


---

# SOURCE: `13_DIAGRAMS/README.md`


# Diagram Set

- `chat-end-to-end.svg` — complete Chat/Manual lifecycle.
- `routing-fallback.svg` — unified capability resolver and fallback policy.
- `realtime-durable-loop.svg` — streaming, checkpointing and recovery relationship.
