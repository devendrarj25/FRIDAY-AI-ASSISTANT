# System State Machine

## Purpose
Define lifecycle states for boot, ready, thinking, executing, waiting, approval, recovering, degraded, updating and shutting down. States describe system truth; UI merely renders them.

## Canonical flow
BOOTING → POLICY_VERIFY → SERVICES_READY → IDLE → ACTIVE_THINKING → PLANNED → AUTHORIZED → EXECUTING → VERIFYING → COMPLETED. Alternate branches: WAITING_APPROVAL, WAITING_EXTERNAL, RECOVERING, DEGRADED, FAILED, CANCELLING, ROLLING_BACK.

## Required contracts
State transitions are events with actor, cause, timestamp, previous state, next state, correlation IDs and evidence reference.

## Failure and recovery
Invalid transitions are rejected and logged. Restart reconstructs state from durable checkpoint + event history.

## Implementation guidance
Use existing lifecycle/startup/assistant-mode/task state rather than adding a new global state store.
