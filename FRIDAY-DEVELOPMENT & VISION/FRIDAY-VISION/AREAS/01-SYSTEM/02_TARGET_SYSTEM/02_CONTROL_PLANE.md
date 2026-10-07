# Control Plane and Data Plane

## Purpose
Separate decisions from execution. The control plane decides what is allowed and what should happen; the data plane performs approved work. This prevents model output from directly becoming a privileged side effect.

## Canonical flow
Control: policy → intent → plan → route → risk → approval → lease. Data: tool/browser/code/device/model execution → result → evidence. Observability mirrors both planes without becoming an authority.

## Required contracts
Action requests carry policy decision, capability ID/version, scope, risk class, approval state, idempotency key and resource limits.

## Failure and recovery
If the control plane is unavailable, privileged data-plane actions fail closed. Read-only/non-sensitive operations may use explicitly defined degraded paths.

## Implementation guidance
Map existing permission/authority/sandbox components into the control/data boundary; never add an independent authorization layer.
