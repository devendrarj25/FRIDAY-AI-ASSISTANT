# 2026 Web + Mobile Companion Research Sources

## Browser permissions
MDN documents that `getUserMedia()` requires a secure context and explicit user permission for microphone/camera access. Permissions Policy can further restrict camera/microphone access. The Permissions API can query permission state where supported, but the actual media call remains the authoritative test of usable access.

Sources:
- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- https://developer.mozilla.org/en-US/docs/Web/API/Permissions_API
- https://developer.mozilla.org/en-US/docs/Web/API/Permissions/query
- https://www.w3.org/TR/permissions/
- https://www.w3.org/TR/permissions-policy/

## WebRTC
W3C WebRTC 1.0 is a Recommendation for realtime media and generic application data between browsers/devices. Its security model includes DTLS-SRTP and consent mechanisms; ICE/STUN/TURN handle connectivity and traversal. FRIDAY must still perform its own authentication/authorization above the transport.

Sources:
- https://www.w3.org/TR/webrtc/
- https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols
- https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity

## WebSocket
MDN identifies WebSocket as widely available but notes it has no built-in backpressure. FRIDAY therefore requires bounded event queues, cursor recovery and safe coalescing for high-rate ephemeral updates.

Source:
- https://developer.mozilla.org/en-US/docs/Web/API/WebSocket

## Mobile push/notifications
MDN documents service-worker-backed persistent notifications for mobile and the Push API's ability to deliver messages even when the app is not foregrounded, subject to platform/browser behavior and permission. FRIDAY treats push as attention/deep-link, then re-fetches authoritative state.

Sources:
- https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API
- https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API

## Voice architecture
OpenAI's 2026 GPT-Live material describes full-duplex listening/speaking and asynchronous delegation to deeper reasoning/tool work. The transferable FRIDAY design principle is a responsive media path separated from slower task execution.

Sources:
- https://openai.com/index/introducing-gpt-live/
- https://openai.com/index/continuous-voice-interaction-with-gpt-live/
- https://openai.com/index/introducing-gpt-live-1-in-the-api/

## Task/artifact streaming
A2A's current specification separates stateful Tasks from Artifacts and defines streaming status/artifact updates plus push notification patterns. FRIDAY adapts these concepts internally without adopting A2A as its task ledger or event bus.

Sources:
- https://a2a-protocol.org/latest/topics/key-concepts/
- https://a2a-protocol.org/v0.3.0/specification/

## Zero-trust remote access
Tailscale's current Grants model combines network and application capabilities with deny-by-default and least-privilege principles. FRIDAY uses this as a vendor-neutral reference for private remote access, while keeping its own authority/governance layer authoritative.

Sources:
- https://tailscale.com/docs/features/access-control/grants
- https://tailscale.com/docs/features/access-control

## Observability
OpenTelemetry's current semantic guidance treats point-in-time state changes as events and duration-bearing operations as spans, with session identifiers connecting client activity. FRIDAY should preserve that separation.

Sources:
- https://opentelemetry.io/docs/specs/semconv/general/events/
- https://opentelemetry.io/docs/specs/semconv/general/session/

## Research conclusion
The strongest architecture is not a collection of vendor features. It is a shared FRIDAY authority model with a low-latency media path, ordered/cursor-based event recovery, artifact-first outputs, browser-mediated permissions, private/least-privilege remote access, and generic mobile rendering over versioned contracts.
