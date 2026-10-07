# Manual + Auto — Dual-Axis Operating Model

## Manual
Manual is owner-directed progression. The user explicitly starts, steers and approves work. Existing background/self-learning/self-development/self-evolution may continue under their own policies, and important events can notify the owner. Manual does not mean “FRIDAY is frozen when the UI is closed.”

## Auto
Auto is an explicit autonomy grant. FRIDAY can advance permitted tasks without waiting for the user to click intermediate controls. It can schedule/replan within the assigned scope and continue durable work.

## Shared rule
Both modes use the same Brain, Task Graph, Router, Capability Registry, Memory, Execution Fabric and Governance. Auto is a policy input, not a separate execution engine.

## Autonomy levels
- `L0`: answer/observe only
- `L1`: reversible low-risk actions
- `L2`: assigned background tasks
- `L3`: multi-step permitted automation
- `L4`: privileged/irreversible actions — still gated; Auto cannot bypass owner approval

## Mode switching
Changing mode does not recreate a task. The runtime updates the mode policy on the active run and recomputes allowed next steps. A step already executing remains governed by the policy snapshot that authorized it unless the policy system explicitly revokes it.

## Cross-surface hardening integration
Manual/Auto policy is evaluated identically whether the initiating surface is Desktop Chat, Desktop Voice, Mobile Chat or Mobile Voice. Remote origin never grants extra authority. Auto can progress only within the current policy envelope; Manual pauses where explicit user action is required. A mode switch updates policy evaluation for subsequent work and does not duplicate or reset the underlying task.
