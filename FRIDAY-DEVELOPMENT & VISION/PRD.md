# FRIDAY — PRD — Product Requirements Document
**Document date:** 2026-09-13  
**Baseline:** FRIDAY 1.0.0.2 (`config/friday-version.json`)  
**Package/npm version:** 1.0.0  
**Source baseline:** `FRIDAY(3).zip`  

> This document is a planning/contract document. It does **not** claim that target capabilities are already implemented.
> The existing FRIDAY UI, build, installer, release pipeline, governance, registries, data and runtime behavior remain protected unless an explicitly approved implementation changes them.

## 1. Product definition

FRIDAY is a private, local-first Windows personal AI operating environment. The next FRIDAY is not a replacement chatbot and not a single-model wrapper. It is a **governed intelligence system** that coordinates models, agents, skills, tools, memory, devices, applications and long-running work while preserving owner control.

The product north star:

> **FRIDAY should be able to understand a goal, build a durable plan, use the minimum required capabilities, ask for authority when needed, execute, verify the real outcome, preserve evidence, recover from failure, and continue later without losing the task state.**

## 2. Baseline that must remain intact

The current repository already exposes a 17-layer live flow contract:

1. Owner / authority
2. Entry
3. Experience
4. Supervisor
5. Voice runtime
6. Thinking
7. Task runtime
8. Orchestrator
9. Model router
10. Agents
11. Capability bus
12. Permission
13. Execution
14. Verification
15. Memory
16. Idle
17. Improvement

The live binding is `src/lib/friday/flow-chart.ts`; it is an index over real modules, not a second implementation.

## 3. Product goals

### P0 — Reliability
- Every consequential action has a traceable task/run/action identity.
- Long-running work survives disconnects, restarts and approval pauses.
- FRIDAY never reports success without a verified postcondition.
- Failed actions have typed failure reasons and recovery paths.

### P0 — Governance
- All privileged/destructive actions continue through the existing authority/governance path.
- Approval is scoped to the exact intended action, arguments, target and lifetime.
- Agents cannot silently escalate their own permissions.
- Secrets never become ordinary model context.

### P0 — Capability federation
- Multiple model providers can be selected by capability, quality, latency, cost, privacy and availability.
- Agents, skills, tools, modules, connectors and workflows remain discoverable through the existing registries.
- New capabilities are registered once and appear through existing surfaces instead of parallel hardcoded lists.

### P0 — Durable work
- Tasks have lifecycle state, checkpoints, leases, dependencies, cancellation, retry policy and recovery metadata.
- Human approval and external completion are first-class waiting states.

### P1 — World awareness
- Screen, browser, application, device and environment observations carry source, timestamp, freshness and confidence.
- Stale observations are not silently treated as current truth.

### P1 — Evidence and provenance
- External facts record provenance.
- Tool calls produce receipts.
- Verification records the observed postcondition.
- User-facing claims can be traced back to evidence.

### P1 — Multi-agent execution
- Specialist agents can work in parallel where safe.
- Shared task state prevents duplicated work.
- Conflicting writes are isolated or serialized.
- A verifier/reviewer can reject unsafe or incomplete outputs.

### P1 — Research and creation
- Deep research, coding, browser work, document generation and analysis become durable workflows rather than fragile single turns.

### P2 — Distributed FRIDAY
- Desktop, mobile, browser and future devices expose capabilities through a common policy-controlled fabric.
- Device-local safety controllers remain authoritative for physical actions.

## 4. Product principles

1. **Owner first.**
2. **Evidence over assertion.**
3. **Verification over optimism.**
4. **One canonical owner per responsibility.**
5. **Local-first and privacy-aware by default.**
6. **Least privilege.**
7. **Durable by design.**
8. **Model-agnostic FRIDAY identity.**
9. **No silent degradation.**
10. **Backward compatibility before novelty.**

## 5. Primary user journeys

### Journey A — Simple request
User asks → FRIDAY understands → chooses capability → executes → verifies → answers.

### Journey B — High-risk request
User asks → plan → risk classification → scoped approval → action → verification → evidence → answer.

### Journey C — Long-running task
User asks → durable task created → workers execute → checkpoints → progress events → optional approval → completion → evidence package.

### Journey D — Research
Goal → research plan → source acquisition → source quality/provenance → synthesis → contradiction check → answer with evidence.

### Journey E — Computer use
Observe current state → determine intended UI action → policy check → action → re-observe → verify state transition → continue.

### Journey F — Failure
Action fails → classify failure → decide retry/recover/ask owner/abort → preserve evidence → never fake success.

## 6. Non-functional requirements

- No regression to current startup, chat, voice, tray, installer or release behavior.
- No second brain.
- No duplicate capability registry.
- No bypass of the current governance path.
- All new state machines are explicit and testable.
- Every asynchronous operation has cancellation semantics.
- Every external dependency has timeout, retry and degradation behavior.
- Sensitive data has explicit retention and redaction rules.
- Target operations are observable without exposing secrets.

## 7. Product acceptance gates

A target feature is **not complete** merely because code exists.

It is complete only when:
- the canonical owner is identified;
- registration/discovery works;
- authority is enforced;
- failure behavior is defined;
- verification exists;
- evidence is persisted where required;
- existing entry surfaces still work;
- the minimum relevant regression tests pass;
- documentation reflects reality.

## 8. Explicit non-goals

- Redesigning the current UI without an approved UX change.
- Replacing the current Electron/React/Python architecture merely for novelty.
- Rewriting the build/installer/release pipeline.
- Making FRIDAY fully autonomous without governance.
- Treating any specific external model provider as FRIDAY itself.
- Adding speculative features that have no verified owner or integration path.


## Research basis (September 2026)

The target architecture is informed by current official documentation:
- OpenAI Agents SDK / Agents API: controlled sandbox execution, long-running sessions, context management and subagents.
- Google Gemini: background execution for long-running interactions and computer-use action loops.
- Anthropic Claude Opus 4.6: long-running agentic coding, context compaction and agent teams.
- MCP 2026-07-28: stateless protocol core, Tasks extension and authorization hardening.

Sources:
- https://openai.com/index/the-next-evolution-of-the-agents-sdk/
- https://openai.com/index/introducing-the-agents-api/
- https://ai.google.dev/gemini-api/docs/background-execution
- https://ai.google.dev/gemini-api/docs/computer-use
- https://www.anthropic.com/news/claude-opus-4-6
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks
