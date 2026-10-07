# 2026 Interaction Architecture Research Addendum

## Research decisions

### Full-duplex voice
Recent OpenAI engineering/product architecture emphasizes a dedicated low-latency media path, full-duplex listening/speaking, and asynchronous delegation for deeper reasoning/tool work. FRIDAY should apply the architectural principle: keep the live audio path small and responsive; do not block it on slow tools, browser actions, or long reasoning. See OpenAI's 2026 engineering write-up and GPT-Live API release.

### Task/artifact separation and streaming
A2A's current model treats Task as durable work state and Artifact as the tangible output, with streaming status/artifact updates and push notifications for disconnected long-running clients. FRIDAY should adapt these semantics internally while keeping its own task ledger as the authority.

### Mobile disconnected operation
A2A's push/retrieval model reinforces that a mobile client should not own task truth. On disconnect, the client can receive a significant notification, then retrieve authoritative task state/artifacts.

### Zero-trust remote access
Tailscale's current access-control direction uses deny-by-default, least privilege and grants that combine network and application permissions. FRIDAY should keep private-overlay remote access as the preferred transport pattern and separately enforce FRIDAY capability scope and governance.

### Observability
OpenTelemetry's event guidance treats events as timestamped occurrences such as user interactions, state transitions, lifecycle moments and outcomes. FRIDAY's event fabric should preserve this separation: events represent occurrences; spans/operations represent work with duration; presentation is a projection.

## Adopt / adapt / reject

| Pattern | Decision | FRIDAY treatment |
|---|---|---|
| Full-duplex voice | ADOPT | Voice media plane separated from deeper task execution |
| Async delegation | ADAPT | Shared Brain/Task runtime remains authoritative |
| A2A Task/Artifact model | ADAPT | Internal canonical task/artifact contracts |
| A2A streaming | ADAPT | Shared event fabric + cursors/versioning |
| Push notification for disconnected mobile | ADAPT | Notification points to authoritative task; mobile re-fetches |
| Tailscale-style private overlay | ADAPT | Preferred remote transport, not vendor lock-in |
| Deny-by-default | ADOPT | Network + session + capability + governance |
| Separate Chat/Voice brains | REJECT | One Brain |
| Mobile-owned task state | REJECT | Durable task truth remains on FRIDAY |
| UI-derived completion | REJECT | Verification/runtime truth only |

## Sources used
- OpenAI — “How we built a realtime system for responsive voice AI in six months” (2026-08-03)
- OpenAI — “Introducing GPT-Live” (2026-07-08)
- OpenAI — “Build more natural voice experiences with GPT-Live-1 in the API” (2026-09-10)
- A2A Protocol — current Key Concepts / Specification / Streaming & Asynchronous Operations
- Tailscale Docs — current Grants / Access Control
- OpenTelemetry — current Events and Session semantic conventions


## Mobile browser and realtime research addendum

### Browser media permissions

MDN's current MediaDevices guidance confirms that `getUserMedia()` is restricted to secure contexts and requires explicit user permission for camera/audio capture. Permission state can be queried through the Permissions API where the browser exposes the relevant permission. FRIDAY therefore uses feature detection → permission-state inspection → user-triggered request → actual media initialization → verified active state, with fallback when unsupported. Permissions Policy must also be respected when media is embedded/composed.

### Realtime browser transport

WebRTC provides a standards-based option for low-latency bidirectional media; WebRTC data channels are encrypted with DTLS. FRIDAY should keep browser media transport separate from application authorization and the canonical task/event system.

### Push/background attention

The Web Push API and service-worker model can deliver asynchronous updates when a web client is not foregrounded, subject to browser/OS support and permission. For FRIDAY, push is an attention/deep-link mechanism; the mobile client must retrieve authoritative task state/artifacts after notification rather than treating notification payloads as task truth.

### PWA

Current web.dev guidance supports an installable PWA as an optional mobile experience on supported browsers/platforms, while retaining browser access as the broad compatibility baseline. Installation is not a prerequisite for core FRIDAY Chat/task/approval behavior.

### Research decisions

| Area | Decision | FRIDAY treatment |
|---|---|---|
| Browser mic/camera | ADOPT platform permission model | Never bypass browser/OS permission |
| Permissions API | ADAPT | Query where supported; actual API call remains authoritative |
| WebRTC | ADAPT | Realtime voice/media path where supported |
| Web Push | ADAPT | Attention + deep-link, followed by authoritative re-fetch |
| Service worker | ADAPT | Shell/cache/push support; never task authority |
| PWA | OPTIONAL ADAPT | Enhanced installed experience, not mandatory |
| Browser compatibility | ADOPT | Capability detection + graceful degradation |
| Pixel-identical mobile UI | REJECT | Responsive mobile presentation over shared semantics |
| Mobile-owned capability registry | REJECT | PC/runtime registry remains authoritative |
| Browser permission = PC permission | REJECT | Separate security/governance layers |
