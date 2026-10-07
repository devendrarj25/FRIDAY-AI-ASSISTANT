# FRIDAY Autonomy Model

## Autonomy levels

### L0 — Assist
No background action. User drives everything.

### L1 — Reactive
FRIDAY may perform safe, reversible actions inside the current request.

### L2 — Background
FRIDAY may inspect, research, summarize, evaluate and prepare proposals while idle.

### L3 — Delegated
FRIDAY may execute pre-approved safe task classes within resource and scope budgets.

### L4 — Improvement
FRIDAY may generate and test improvement candidates automatically, but production promotion remains gated by policy.

### L5 — Evolution Lab
Population-based candidate search, workflow evolution and local adapter experiments are allowed only in isolated workspaces with hard resource/time/network limits.

Default target: L2/L3. L4 requires explicit owner enablement. L5 should be opt-in and separately visible.

## Scoped autonomy
Global autonomy is insufficient. Add per-class policies:
- research
- memory-write
- skill-install
- tool-install
- workflow-change
- routing-policy-change
- adapter-training
- code-change
- system-update

Each class has:
`allowed mode + max budget + approval requirement + rollback requirement + sandbox requirement`.

## Autonomy budget
Track:
- wall time
- model calls
- token budget
- cost budget
- concurrent workers
- filesystem writes
- network domains
- subprocess count
- training compute

A budget exhaustion is a normal stop, not a failure.
