# FRIDAY — UI/UX Design Document
**Document date:** 2026-09-13  
**Baseline:** FRIDAY 1.0.0.2 (`config/friday-version.json`)  
**Package/npm version:** 1.0.0  
**Source baseline:** `FRIDAY(3).zip`  

> This document is a planning/contract document. It does **not** claim that target capabilities are already implemented.
> The existing FRIDAY UI, build, installer, release pipeline, governance, registries, data and runtime behavior remain protected unless an explicitly approved implementation changes them.

## 1. UX objective

The next FRIDAY should **feel like the same FRIDAY**, not like a redesigned product.

The UI is an observation/control surface for the intelligence system. The visual language, navigation structure, existing components and interaction patterns are protected unless an explicit UX task changes them.

The main upgrade is **truthfulness and explainability**, not decoration.

## 2. Existing surfaces to preserve

Current route inventory includes:
- `/`
- `/brain`
- `/status`
- `/tools`
- `/agents`
- `/system`
- `/doctor`
- `/terminal`
- `/skills`
- `/plugins`
- `/memory`
- `/sandbox`
- `/models`
- `/settings`
- `/connectors`
- `/workspace`
- `/projects`
- `/self-management`
- `/workflows`
- `/devices`
- `/tasks`
- `/library`
- `/modules`
- `/logs`
- `/browser`
- `/n8n`
- `/hub`
- `/character`
- `/install-manager`
- `/import`

These surfaces should be extended through existing patterns, not duplicated.

## 3. UX principles

### A. Never fake state
“Connected”, “working”, “installed”, “verified” and similar statuses must come from real checks.

### B. Show the right amount of detail
Default view: concise.
Drill-down: plan, current step, capability, provider, permission, evidence, verification.

### C. Preserve owner control
Approval prompts must clearly state:
- what FRIDAY wants to do;
- where;
- why;
- what data leaves the machine;
- risk level;
- whether the action is reversible;
- exact scope;
- expiry.

### D. Make waiting visible
Long-running tasks need:
- current state;
- elapsed time;
- last successful checkpoint;
- what is blocking progress;
- cancel/pause/resume state.

### E. Evidence is inspectable
A result should be able to show:
- source;
- observation;
- action receipt;
- verification;
- timestamp;
- confidence.

### F. Errors are actionable
Do not show only “Something went wrong”.
Show:
- failed step;
- reason;
- whether anything changed;
- recovery status;
- next safe action.

## 4. Target interaction states

### Task card
```text
Task
Goal
Status
Current step
Progress
Last checkpoint
Waiting for: owner / external / retry
Capabilities in use
Verification
Evidence
```

### Approval card
```text
FRIDAY wants permission to:
Target:
Reason:
Data leaving device:
Risk:
Reversible:
Scope:
Expires:
[Approve] [Reject] [Inspect]
```

### Agent run
```text
Agent
Mission
Parent task
Capabilities
Current step
Budget
Policy state
Checkpoint
Evidence
Verifier result
```

### Capability status
```text
Capability
Provider
Health: verified/unavailable/unknown
Last checked
Required permission
Privacy/egress
Cost estimate
Verification support
```

## 5. Voice UX

Voice and typed interaction continue through the same cognition path.

Voice states should distinguish:
- idle
- listening
- interpreting
- planning
- waiting approval
- acting
- verifying
- speaking
- error
- paused

Do not imply execution while FRIDAY is only reasoning.

## 6. Long-running UX

Background tasks should remain discoverable from existing task/status surfaces.

Notifications should be event-driven and deduplicated:
- task started;
- approval required;
- meaningful progress;
- blocked;
- completed;
- failed;
- recovered.

No notification spam.

## 7. Safety UX

High-risk operations require explicit intent and scope.

The user should never be asked to approve a vague statement such as “allow FRIDAY to continue”.

Instead, approval must identify the exact action or bounded set of actions.

## 8. Accessibility and robustness

- Keyboard-first operation remains supported.
- Voice is additive, not required.
- UI remains usable when providers are unavailable.
- Loading/empty/error states are explicit.
- Offline/local-only state is distinguishable from provider failure.
- UI must not expose secrets in logs or traces.

## 9. Visual-change rule

No new visual design system is authorized by this document.

If a future feature requires UI changes, the implementation must first reuse the closest existing component and pattern. New visual primitives require explicit UX scope.

## 10. UX acceptance

A feature passes UX acceptance when:
- the existing flow remains recognizable;
- every displayed state is backed by real runtime state;
- approvals are unambiguous;
- long-running tasks remain understandable;
- errors explain what actually happened;
- no sensitive data leaks through status surfaces.
