# Master Interaction Upgrade Execution Order

## Phase 0 — Inspect and baseline
Inspect existing source ownership for Brain, task ledger, capability registry, governance, bridge, remote-access, voice runtime, chat runtime, notifications, device services and build/release. Confirm the current source implementation before editing.

## Phase 1 — Canonical contracts
Add/extend only the canonical interaction/session/capability/permission/sync contracts in `10_CONTRACTS/`. Reuse existing schemas where they already represent the requirement.

## Phase 2 — Shared bridge/runtime
Implement handshake, runtime snapshot, event cursor, reconnect and idempotency using existing bridge/event infrastructure. Do not create a second event bus.

## Phase 3 — Mobile connection/trust
Integrate existing remote-access/companion services. Add pairing, session expiry/revocation and scope reporting through the existing authority path.

## Phase 4 — Mobile dynamic surface
Implement generic renderers against the authoritative capability/result/task schemas. Do not hardcode a parallel feature registry.

## Phase 5 — Browser media
Implement permission detection/request/verification for microphone/camera and realtime media using browser-supported APIs. Test supported browsers and truthful degradation.

## Phase 6 — Chat/Voice integration
Verify Chat and Voice use the same task/generation/governance/event contracts. Preserve existing Voice barge-in semantics and Chat rich-output behavior.

## Phase 7 — Manual/Auto integration
Verify remote commands carry the same policy context and cannot bypass governance. Test mode transitions on active tasks.

## Phase 8 — Realtime/failure hardening
Test reconnect, cursor gaps, stale generations, duplicate commands, unknown side effects, revoked sessions and provider failure.

## Phase 9 — Verification
Run only targeted tests required by the changed areas, then required build/boot/install/regression checks. Do not touch packaging/installer/release files unless a real dependency makes it necessary.

## Phase 10 — Documentation truth
Update relevant FRIDAY docs to the actual implemented state. Never mark a capability connected/installed/working without runtime evidence.

## Stop conditions
Stop and ask before changes that are destructive, irreversible, build/release-wide, security-boundary-wide beyond this scope, or require a new external infrastructure dependency that changes the product's trust model.
