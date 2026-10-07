# Chat — Final Integrated Architecture

## Purpose
Chat is the typed/manual visual surface over the shared FRIDAY runtime. It is not a ChatBrain, ChatTaskManager or ChatMemory.

## Pipeline
`Typed text/attachment → Chat surface → turn gateway → normalization → session rehydration → context compiler/retrieval → intent/objective → cognitive orchestrator → capability resolution → model/agent/tool/workflow routing → fallback planner → governance → execution/task runtime → observation → verification → memory/learning candidates → response/artifact composer → event stream → Chat presentation`.

## Smart behavior
Chat must classify the request before selecting an execution path. It should distinguish direct answer, clarification, retrieval, research, artifact generation, browser/computer use, external system mutation, background work and multi-step durable task.

The planner selects the smallest safe path, not the largest available stack. It can skip unnecessary tools, reuse verified results, branch to parallel independent work, wait for input, or replan after evidence.

## Context
Context is budgeted. Preserve active objective, hard constraints, decisions, unresolved questions, verified facts, current task state and relevant memory. Compaction must not silently discard commitments or approvals.

## Streaming
Token/progress streaming is presentation; the authoritative response/task state lives in runtime. A canceled or superseded generation cannot append stale output.

## Attachments
Attachments are normalized into typed references with provenance, permissions and extraction status. The model receives extracted/authorized content, not an implicit unlimited filesystem view.

## Manual mode
Chat remains the primary explicit-control surface. It can start/continue tasks, inspect progress, approve actions, cancel/pause/resume and request artifacts, but it never bypasses governance.

## Error behavior
Errors are typed. A model failure may trigger bounded model fallback; a tool failure may trigger capability fallback; a permission failure must not be “retried harder”; an uncertain side effect must reconcile first.

## Interaction-system hardening integration
Chat is the canonical rich textual/visual projection of the shared interaction runtime. Its controls must expose current capability metadata rather than a second capability list. Every turn carries canonical IDs and version metadata, and every streamed update is tied to an event cursor/generation. Chat may start, inspect, steer, approve, pause, resume or cancel a task only through the shared authority path. A result shown as complete must come from runtime verification, not from model text alone.
