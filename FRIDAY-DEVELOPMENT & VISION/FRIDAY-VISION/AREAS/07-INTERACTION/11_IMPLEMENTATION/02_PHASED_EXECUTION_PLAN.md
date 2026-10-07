# Phased Implementation Plan

## Phase 0 — inspect and baseline
Inventory current checkout, current Chat/Voice/Companion behavior, IPC channels, task persistence, governance, registries and tests. Record evidence before edits.

## Phase 1 — canonical interaction contracts
Implement/verify turn/task/event/generation/approval/result schemas and adapters around existing owners. Do not redesign UI.

## Phase 2 — shared turn/task bridge
Make Chat and Voice ingress create the same canonical turn shape. Make Mobile commands target the same task authority. Add stale-generation checks at the runtime boundary.

## Phase 3 — Chat integration
Wire context, routing, fallback, execution, verification, streaming and task continuation through existing owners. Preserve current ChatDock design.

## Phase 4 — Voice realtime integration
Harden device/clock/VAD/streaming ASR/TTS/full duplex/barge-in. Connect transcript to the shared turn gateway and response stream to the shared task/event fabric.

## Phase 5 — Manual/Auto policy integration
Make mode explicit in runtime state. Manual waits for user decisions where required; Auto advances permitted work. Governance remains common.

## Phase 6 — Mobile continuity
Authenticate device/session, private overlay, cursor/snapshot sync, remote commands, approvals, artifacts and reconnect/reconciliation.

## Phase 7 — failure/recovery hardening
Inject disconnects, provider failure, stale generations, duplicate commands, unknown side effects, approval expiry and renderer restart. Fix only the relevant owner.

## Phase 8 — acceptance/regression
Run targeted tests, typecheck/build evidence and existing relevant verification. Confirm installer/release behavior is unchanged. Update documentation only to reflect verified reality.
