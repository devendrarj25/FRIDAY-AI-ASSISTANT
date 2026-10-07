# FRIDAY Interaction System — Final Cross-Surface Architecture

## 1. Authority model
FRIDAY is one runtime. Chat, Voice and Mobile are experience surfaces. Manual and Auto are operating-policy modes. No surface or mode owns a separate Brain, planner, task ledger, memory, capability registry, execution authority, or governance system.

Canonical identifiers flow through every surface: `owner_id`, `policy_version`, `conversation_id`, `turn_id`, `generation_id`, `task_id`, `plan_id`, `route_id`, `action_id`, `artifact_id`, `trace_id`, `session_id`, `capability_version`, `protocol_version`, and `event_cursor` where applicable.

## 2. Canonical lifecycle
`input → normalize → rehydrate → understand → plan → resolve capability → authorize/govern → execute → observe → verify → commit truth → publish event/artifact → project per surface → learn/consolidate`.

A surface may change presentation or input modality, never the authoritative lifecycle.

## 3. Chat
Chat is the richest textual/visual control surface. It supports ordinary conversation, long-running work, streaming, attachments, rich results, artifacts, approvals, progress, steering, cancellation, evidence and cross-surface continuation. Chat uses the same task and governance truth as Voice and Mobile.

## 4. Voice
Voice is a low-latency media experience over the same runtime. The live media path must remain responsive while deeper reasoning/tools execute asynchronously. Full-duplex operation, interruption/barge-in, generation invalidation, audio-clock integrity, provider fallback and concise spoken presentation are mandatory. A barge-in interrupts speech presentation; it does not silently cancel durable work.

## 5. Mobile Companion
Mobile is a complete mobile-optimized FRIDAY operating surface. It exposes the compatible Chat and Voice controls, task/work state, approvals, artifacts, activity, Manual/Auto controls, device/remote controls, pairing, permissions, connection state and security controls. Its layout is mobile-specific; its semantics and working flow are shared.

Mobile has no authoritative task/capability state of its own. It obtains runtime metadata and state through a versioned handshake and event cursor. Cached state is visibly stale and never authorizes a mutation.

## 6. Manual and Auto
Manual means user-directed operation with explicit user decisions where policy requires them. Auto permits eligible low-risk autonomous progression. Both use the same task graph, ledger, capability registry, governance, execution fabric and verification. Mode changes update policy context; they do not fork tasks or recreate plans.

## 7. Remote operation
Mobile commands enter the same authority boundary as desktop commands. Network access, authenticated session authority, capability authorization and action-risk governance are separate checks. High-risk/destructive/system actions cannot bypass FRIDAY governance because the command originated remotely.

## 8. Realtime planes
- Control plane: authenticated commands, approvals, steering, session control.
- Event plane: ordered durable/ephemeral state events and cursors.
- Media plane: realtime audio/video using browser-approved mechanisms.
- Artifact plane: files, images, reports and structured deliverables.
- Attention plane: notifications/deep links that point back to authoritative state.

No notification, browser cache, UI state or media stream becomes task truth.

## 9. Freshness and upgrades
Runtime capability metadata is authoritative. Refresh/reconnect performs version negotiation, snapshot reconciliation, event catch-up and cache validation. Generic UI contracts allow ordinary new capabilities to appear without bespoke mobile code. If a capability requires a new interaction primitive that the installed client cannot represent, it must be marked incompatible rather than guessed or falsely exposed.

## 10. Failure invariant
Unknown side effects remain unknown until reconciled. Stale generations cannot overwrite newer truth. Duplicate commands are prevented with idempotency keys. Reconnect is observation recovery, not permission to replay mutations.

## 11. Non-negotiable preservation
Do not redesign the existing desktop UI, replace working services, create duplicate registries, bypass governance, or modify build/install/release files unless implementation evidence proves the change is required.
