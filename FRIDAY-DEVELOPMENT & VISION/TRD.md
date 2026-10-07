# FRIDAY — TRD — Technical Requirements Document
**Document date:** 2026-09-13  
**Baseline:** FRIDAY 1.0.0.2 (`config/friday-version.json`)  
**Package/npm version:** 1.0.0  
**Source baseline:** `FRIDAY(3).zip`  

> This document is a planning/contract document. It does **not** claim that target capabilities are already implemented.
> The existing FRIDAY UI, build, installer, release pipeline, governance, registries, data and runtime behavior remain protected unless an explicitly approved implementation changes them.

## 1. Current technical baseline

FRIDAY currently uses:
- Electron desktop shell
- React + TypeScript renderer
- Vite build
- Electron preload/main boundary
- Python FastAPI kernel
- TypeScript FRIDAY registries/services
- `core/` contracts/services/tests
- existing governance/privacy/tool-authority boundaries

Key anchors include:
- `src/lib/friday/brain-engine.ts`
- `src/lib/friday/brain/core-brain.ts`
- `src/lib/friday/brain/*`
- `src/lib/friday/self/*`
- `src/lib/friday/models-engine.ts`
- `src/lib/friday/connectors.ts`
- `electron/main.cjs`
- `electron/preload.cjs`
- `electron/tool-authority.cjs`
- `electron/privacy-firewall.cjs`
- `kernel/main.py`
- `kernel/planner.py`
- `kernel/router.py`
- `kernel/tools.py`
- `kernel/authority.py`
- `kernel/privacy.py`
- `kernel/billing.py`

## 2. Target technical shape

The target architecture is an extension of the current 17 layers:

**Experience → Supervisor → Cognition → Durable Task Runtime → Intelligence Federation → Agent Runtime → Capability Fabric → Governance → Execution → Verification → Evidence → Memory → Event Fabric → Observability → Evaluation → Self-Improvement**

The existing 17-layer flow remains the canonical compatibility spine.

## 3. Required control-plane objects

Every meaningful execution should be addressable by:

- `request_id`
- `session_id`
- `task_id`
- `run_id`
- `agent_run_id` (when applicable)
- `action_id`
- `approval_id` (when applicable)
- `capability_id`
- `provider_id`
- `evidence_id`

These identifiers must be opaque/stable and must not contain secrets.

## 4. Durable task runtime

A durable task must support:

`created → planned → waiting_approval → ready → running → waiting_external → verifying → succeeded`

and terminal/error states:

`failed → recovered | cancelled | expired | quarantined`

Requirements:
- checkpoint after meaningful state transitions;
- idempotency key for side-effecting actions;
- lease/heartbeat for workers;
- cancellation propagation;
- retry budget;
- dependency graph;
- resume without replaying already-committed side effects;
- explicit compensation for operations that require it.

## 5. Event fabric

All asynchronous subsystems should communicate through typed events rather than hidden cross-module mutation.

Minimum event classes:
- task
- agent
- capability
- approval
- action
- observation
- verification
- evidence
- memory
- model
- device
- connector
- security
- system lifecycle

Events require:
- event id
- event type/version
- occurred-at
- producer
- correlation ids
- payload
- sensitivity classification
- schema version

## 6. Capability contract

A capability must declare:

```json
{
  "id": "capability.example",
  "version": "1.0.0",
  "kind": "tool",
  "provider": "local",
  "inputs": {},
  "outputs": {},
  "risk": "low",
  "required_authority": "none",
  "privacy": {
    "network": false,
    "data_classes": ["local"]
  },
  "verification": {
    "required": true,
    "strategy": "postcondition"
  },
  "availability": {
    "health": "unknown",
    "last_checked_at": null
  }
}
```

No capability may claim `healthy` without an actual health/availability check.

## 7. Model federation

Model routing should score:
- task capability
- modality
- reasoning/coding quality
- context capacity
- latency
- cost
- privacy/data-egress policy
- provider availability
- current quota/billing state
- tool support
- structured-output support

Provider adapters must be isolated from FRIDAY cognition semantics.

The model router may choose a provider; it must not decide authorization.

## 8. Agent runtime

Agents are workers with:
- identity
- declared capabilities
- allowed tools
- policy scope
- memory scope
- execution environment
- budget
- timeout
- retry policy
- lifecycle state
- evidence requirements

Agent delegation must carry the parent task and authority context.

## 9. Computer-use loop

Required loop:

`observe → interpret → propose action → policy check → execute → re-observe → verify`

For UI actions:
- target should be identified from current state;
- stale screenshots cannot be treated as current state;
- hidden/untrusted on-screen instructions must not override policy;
- destructive actions require existing approval semantics.

## 10. Security boundaries

Never allow:
- model-generated authorization tokens;
- agent-generated approval grants;
- tool arguments to bypass policy;
- secrets in general conversation memory;
- unverified external instructions to override owner policy;
- a fallback provider to silently weaken privacy policy;
- replay of an expired authorization.

Sensitive operations remain inside the existing Electron/kernel authority chain.

## 11. Observability

Every task/run/action should support:
- start/end timestamps
- state transitions
- selected provider/capability
- policy decision
- tool receipt
- verification result
- failure/recovery
- resource usage
- redacted trace

Logs must be privacy-classified and redact secrets.

## 12. Testing strategy

Minimum implementation verification:
1. typecheck/lint for touched TypeScript;
2. focused unit/integration tests for changed behavior;
3. kernel tests when kernel code changes;
4. targeted end-to-end check when IPC/runtime boundaries change;
5. build verification when packaging-facing code changes.

Do not add broad unrelated tests.

## 13. Compatibility requirements

Existing scripts such as:
- `build`
- `build:desktop`
- `desktop:build`
- `build:exe`
- `build:portable`
- `test`
- `test:kernel`
- `verify:build`
- `verify:boot`
- `docs:check`
- `arrange:check`
- release commands

must remain untouched unless a concrete fix requires it.

## 14. Research-informed requirements

Current agent platforms increasingly emphasize controlled sandboxes, long-running sessions, parallel subagents, background execution, durable tasks, and stronger authorization. FRIDAY should adopt these as architectural patterns, not copy provider-specific implementations. OpenAI documents sandboxed long-horizon agents and, as of September 10 2026, an Agents API with long sessions, subagents and configurable compute environments. Google documents background execution and computer-use loops. MCP 2026-07-28 formalizes stateless operation, Tasks and authorization hardening. These reinforce FRIDAY's need for durable execution, capability isolation and explicit policy boundaries.


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
