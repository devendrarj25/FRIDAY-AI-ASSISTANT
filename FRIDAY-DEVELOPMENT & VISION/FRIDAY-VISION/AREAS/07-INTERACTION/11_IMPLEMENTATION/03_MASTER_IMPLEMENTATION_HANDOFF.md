# Master Implementation Handoff

You are implementing the final FRIDAY Interaction System upgrade in the existing Windows FRIDAY project.

Follow: **INSPECT → UNDERSTAND → MODIFY ONLY WHAT IS REQUIRED → INTEGRATE → TEST → REGRESSION-TEST → CONFIRM.**

### Before editing
Inspect the current checkout, not this package alone. Locate existing owners for Brain, context, routing, capability registry, model registry, tasks, memory, governance, event bus, voice, companion, Electron IPC and kernel. Prove ownership before creating anything.

### Hard rules
- No second brain.
- No second task manager/scheduler/memory/model/capability registry/event bus.
- Chat/Voice/Mobile are surfaces; Manual/Auto are modes.
- All surfaces share canonical IDs and task truth.
- Voice barge-in interrupts speech generation, not automatically durable work.
- Mobile reconnect reconciles state; never blindly replays commands.
- Auto never bypasses governance.
- Unknown side effects reconcile before retry.
- Verified results are reusable when freshness/scope permit.
- UI remains presentation; runtime owns truth.
- Do not redesign the existing UI.
- Do not touch build/installer/release unless proven necessary.
- Destructive/system actions must pass the existing approval/governance gate.

### Completion gate
Do not claim “working” because code exists. Demonstrate the relevant runtime path with real evidence: tests, typecheck/build or actual workflow execution. Verify Chat→task, Voice→same task, Mobile→same task, Manual/Auto policy behavior, barge-in stale-generation protection, disconnect/reconnect, approval resume, verification truth and regression of existing build/install behavior.
