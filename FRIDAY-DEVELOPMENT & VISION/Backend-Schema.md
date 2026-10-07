# FRIDAY — Backend Schema
**Document date:** 2026-09-13  
**Baseline:** FRIDAY 1.0.0.2 (`config/friday-version.json`)  
**Package/npm version:** 1.0.0  
**Source baseline:** `FRIDAY(3).zip`  

> This document is a planning/contract document. It does **not** claim that target capabilities are already implemented.
> The existing FRIDAY UI, build, installer, release pipeline, governance, registries, data and runtime behavior remain protected unless an explicitly approved implementation changes them.

## 1. Purpose

This document defines the **logical backend contract** for the next FRIDAY. It is not permission to create a parallel database or service. Existing persistence, stores, IPC and registries remain the first implementation candidates.

## 2. Canonical entities

### Request
```json
{
  "request_id": "req_*",
  "session_id": "ses_*",
  "channel": "chat|voice|device|event",
  "input": {},
  "received_at": "ISO-8601",
  "policy_context_id": "polctx_*"
}
```

### Task
```json
{
  "task_id": "task_*",
  "request_id": "req_*",
  "goal": "string",
  "status": "created|planned|waiting_approval|ready|running|waiting_external|verifying|succeeded|failed|recovered|cancelled|expired|quarantined",
  "parent_task_id": null,
  "dependencies": [],
  "checkpoint_id": "chk_*",
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601",
  "retry_budget": 3,
  "idempotency_key": "idem_*"
}
```

### Run
```json
{
  "run_id": "run_*",
  "task_id": "task_*",
  "run_type": "cognition|agent|workflow|tool",
  "status": "running",
  "started_at": "ISO-8601",
  "ended_at": null,
  "worker_id": null
}
```

### Capability
```json
{
  "capability_id": "cap_*",
  "version": "semver",
  "kind": "skill|tool|module|connector|workflow|agent",
  "owner_registry": "canonical-registry-id",
  "provider_id": "provider_*",
  "risk": "none|low|medium|high|critical",
  "authority": "none|owner|scoped|privileged",
  "privacy": {
    "network": false,
    "data_classes": []
  },
  "verification": {
    "required": true,
    "strategy": "receipt|postcondition|independent-check|human"
  }
}
```

### Model provider
```json
{
  "provider_id": "provider_*",
  "model_id": "model_*",
  "capabilities": ["text","vision","audio","coding","tool-use"],
  "availability": "unknown|healthy|degraded|unavailable",
  "privacy_profile": "local|trusted-cloud|restricted-cloud",
  "cost_profile": {},
  "limits": {}
}
```

### Approval
```json
{
  "approval_id": "approval_*",
  "task_id": "task_*",
  "action_id": "action_*",
  "scope_hash": "sha256:*",
  "risk": "medium",
  "decision": "pending|approved|rejected|expired|revoked",
  "expires_at": "ISO-8601",
  "approved_by": "owner",
  "created_at": "ISO-8601"
}
```

### Action receipt
```json
{
  "action_id": "action_*",
  "task_id": "task_*",
  "capability_id": "cap_*",
  "arguments_hash": "sha256:*",
  "authorization_id": "auth_*",
  "started_at": "ISO-8601",
  "ended_at": "ISO-8601",
  "result": "success|failure|partial|cancelled",
  "external_effect": "none|unknown|changed",
  "evidence_ids": []
}
```

### Observation
```json
{
  "observation_id": "obs_*",
  "source": "screen|browser|device|filesystem|network|user|tool",
  "captured_at": "ISO-8601",
  "fresh_until": "ISO-8601",
  "confidence": 0.0,
  "content_ref": "redacted-or-local-ref",
  "sensitivity": "public|internal|private|secret"
}
```

### Verification
```json
{
  "verification_id": "ver_*",
  "action_id": "action_*",
  "strategy": "postcondition|receipt|independent-check|human",
  "expected": {},
  "observed": {},
  "status": "passed|failed|inconclusive",
  "verified_at": "ISO-8601"
}
```

### Evidence
```json
{
  "evidence_id": "ev_*",
  "kind": "source|observation|action-receipt|verification|artifact",
  "source_ref": "string",
  "captured_at": "ISO-8601",
  "content_hash": "sha256:*",
  "provenance": {},
  "sensitivity": "public|internal|private|secret"
}
```

## 3. Invariants

1. A succeeded task must have a successful verification when verification is required.
2. An approved action must be bound to the exact intended scope.
3. An expired/revoked approval cannot authorize execution.
4. A tool success response is not automatically proof of external success.
5. An observation has a freshness boundary.
6. Secret content is never promoted to ordinary semantic memory.
7. Every side-effecting action has an idempotency strategy.
8. Every async task has a cancellation path.
9. Every provider result can be attributed to a provider/model identity.
10. Every externally sourced factual answer can carry provenance when applicable.

## 4. Storage guidance

Prefer existing FRIDAY stores and engines. Add schema only where the current owner cannot safely represent the new state.

Do not create:
- a second task database;
- a second model registry;
- a second approval store;
- a second memory system;
- a second connector registry.

## 5. Versioning

Schemas must be versioned. Backward-compatible additions are preferred. Breaking changes require migration planning and explicit acceptance gates.

## 6. Privacy

Sensitive fields should be referenced by secure local identifiers or protected stores instead of copied into general-purpose event payloads.


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
