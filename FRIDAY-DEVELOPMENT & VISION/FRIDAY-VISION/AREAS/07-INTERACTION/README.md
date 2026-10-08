# FRIDAY Interaction System — Chat + Voice + Mobile Companion + Manual + Auto

## Purpose
This is the **complete interaction architecture / upgrade-plan section** for FRIDAY. It merges the supplied detailed Chat and Voice architectures with the current FRIDAY Brain and System OS architecture, and adds the missing Mobile Companion UI/output/presentation architecture.

## Non-negotiable model
- **One Brain**
- **One FRIDAY System runtime**
- **One canonical task truth**
- **One memory/knowledge truth**
- **One capability registry**
- **One governance/authority path**
- **One event fabric**
- **One execution fabric**
- Chat / Voice / Mobile = experience surfaces
- Manual / Auto = operating-policy axis

No surface gets a separate brain, planner, task database, memory, or governance bypass.

## What is included
### Chat
The detailed Chat source architecture is preserved and consolidated, including turn gateway, normalization, rehydration, context, intent, planning, capability routing, model/skill/tool/plugin/module/workflow/agent/connector routing, browser/PC/device routing, fallback, health, retry/idempotency, execution, observation, verification, memory/learning, response composition, presentation, streaming, cancellation, recovery, progress, result reuse, runtime, IPC, storage, performance, contracts, implementation, acceptance and handoff.

### Voice
The detailed Voice source architecture is preserved and consolidated, including media pipeline, AEC/NS/AGC/VAD, full duplex, barge-in, streaming ASR/TTS, device clock, session state, generation contract, context/memory parity, provider matrix, local-first policy, Hinglish policy, install/runtime/health/license, governance, camera/screen privacy, device/vision/multidisplay, diagnostics, security, implementation, acceptance and reference material.

### Mobile Companion
Includes remote access/control, device trust, task continuity, reconnect/cursor reconciliation, remote command semantics, and a detailed functional UI architecture covering Chat, Tasks, Approvals, Artifacts, Activity, Devices/Remote Control, Notifications, Settings, accessibility and low-bandwidth degradation.

### Output / Presentation
Defines one canonical result and how FRIDAY presents it through Chat, Voice, Mobile, desktop, notifications and artifacts. Includes output rendering matrix, live state projection, streaming/artifact lifecycle and voice/visual coordination.

### Manual / Auto
Defines the dual-axis operating model, background/proactive behavior, autonomy policy matrix, scheduling/yielding and end-to-end behavior. Switching modes never forks or recreates the task/Brain.

## Source preservation
The supplied Chat and Voice ZIPs were not simply attached as nested archives. Their detailed documents were inspected and their requirements were consolidated into this architecture, with a preservation ledger and integrated source-detail documents.

## Implementation truth
This package is an architecture/upgrade plan, not proof that every planned behavior is already implemented in the FRIDAY source repository. Real implementation must be verified with actual source edits, tests, build, boot/install and regression evidence.

## Read order
1. `00_MASTER/00_READ_FIRST.md`
2. `00_MASTER/01_MODE_SURFACE_MATRIX.md`
3. `01_SHARED_SYSTEM/`
4. `02_CHAT/`
5. `03_VOICE/`
6. `04_MOBILE/`
7. `05_MANUAL_AUTO/`
8. `06_CROSS_SURFACE/`
9. `07_FAILURES/` and `07_REALTIME_PRESENTATION/` (both keep 07)
10. `08_SECURITY/`
11. `09_RESEARCH/`
12. `10_CONTRACTS/`
13. `11_IMPLEMENTATION/`
14. `12_ACCEPTANCE/`
15. `13_DIAGRAMS/`
16. `14_DOCUMENT_CONTROL/`
17. `15_INTEGRATED_SOURCE_CONTRACTS/`
18. `90_MERGE_LEDGER/`
## Mobile Companion Deep Upgrade (2026-09-15)

The Mobile Companion is explicitly upgraded from a remote companion surface into a **complete mobile-optimized FRIDAY operating surface** while preserving the one-runtime architecture.

The phone browser can expose the compatible/authorized Chat and Voice experience, tasks, approvals, artifacts, activity, connection management, permissions, and permitted remote PC/FRIDAY controls. The mobile layout is intentionally device-optimized rather than pixel-identical to desktop; FRIDAY semantics and working flow remain shared.

The upgrade adds:
- complete mobile remote-experience contract
- dynamic capability/schema/version synchronization
- refresh/reconnect snapshot + event-cursor reconciliation
- separate control/event/media/artifact transport model
- browser permission/device capability architecture
- same-network and private remote connection/pairing UX
- session and permission state machines
- all-phone/browser compatibility strategy with explicit degradation
- implementation/acceptance plan
- mobile session/capability/command/permission/sync contracts

Browser security is treated as a hard boundary: microphone/camera require the browser's permitted secure-context/media flow and user permission; FRIDAY never bypasses browser or OS security. Network connectivity, browser permission, FRIDAY session authorization, capability authorization, and action-risk governance remain separate layers.

A FRIDAY EXE/runtime upgrade changes the authoritative capability catalog. On mobile refresh/reconnect, the client re-negotiates versions, obtains current runtime/capability metadata, reconciles state, and renders newly compatible capabilities through generic contract-driven components. A bespoke mobile implementation is required only when a genuinely new interaction primitive/protocol cannot be represented by the existing renderer.

This section does not authorize any UI redesign of the existing desktop FRIDAY product and does not change build/install/release architecture.


## Final architecture hardening pass — 2026-09-15

This revision is a consolidation/hardening pass over the complete interaction package. No existing document, source-detail preservation document, diagram, contract, or feature requirement is intentionally removed. New documents add missing cross-surface authority, mobile web runtime/security, session/version synchronization, remote operation, and complete acceptance rules.

### Canonical document rule
- `00_MASTER/` defines cross-surface architecture and invariants.
- `01_SHARED_SYSTEM/` defines shared runtime truth.
- `02_CHAT/`, `03_VOICE/`, `04_MOBILE/`, and `05_MANUAL_AUTO/` define surface/mode-specific behavior.
- `06_CROSS_SURFACE/`, `07_REALTIME_PRESENTATION/`, and `08_SECURITY/` define shared interaction boundaries.
- `10_CONTRACTS/` is the canonical contract location for implementation.
- `15_INTEGRATED_SOURCE_CONTRACTS/` is preserved source-reference material only; it is not a second runtime authority.
- Existing source code remains authoritative for implementation reality.

### Mobile freshness rule
A FRIDAY runtime/EXE update must not require a bespoke mobile edit for ordinary new capabilities. On load/refresh/reconnect, the mobile client negotiates protocol/schema versions, fetches the authoritative runtime/capability snapshot, invalidates stale cached projections, reconciles event cursors, and renders any capability expressible by the supported generic UI contract. A new renderer/protocol primitive is the only normal reason a mobile web client release is required.

### Browser security rule
Camera/microphone/media access is always mediated by the phone OS/browser. FRIDAY may explain and request permission from a user gesture, but never bypasses browser security. Secure context, Permissions Policy, permission state, active-media verification, and revocation are all first-class runtime states.
