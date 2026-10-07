# Mobile Browser Runtime, Security and Compatibility — Final Contract

## Secure context
Camera/microphone capture requires a secure context and explicit user permission. FRIDAY's remote service must therefore be reachable through an HTTPS/WSS origin or an equivalent browser-recognized secure context. A plain remote HTTP origin must not be treated as a supported media mode.

## Permission lifecycle
1. Detect API availability.
2. Query permission state when supported.
3. Explain why the permission is needed.
4. Request only from an appropriate user gesture.
5. Start the media API.
6. Verify an actual active track/device state.
7. Reflect active/paused/stopped/revoked state.
8. Stop tracks and clear FRIDAY media authority on disconnect/revoke.

The Permissions API is a query/observation aid, not proof that media is usable; the actual media API call remains authoritative.

## Permissions Policy
If the mobile client embeds media-capable components, HTTP Permissions-Policy and iframe `allow` configuration must explicitly permit only the required origins/features. Avoid unnecessary third-party frames for privileged controls.

## Realtime media
Use WebRTC where low-latency bidirectional audio/video is required and the browser supports it. ICE/STUN/TURN are transport mechanisms, not authorization. Application identity and FRIDAY session authorization must be established before privileged media/control use. WebRTC's encrypted media/data mechanisms do not replace FRIDAY authorization.

## Application control channel
WebSocket is appropriate for ordered control/event messaging where the existing bridge supports it. Because WebSocket has no built-in backpressure, the client must bound queues, coalesce safe ephemeral events, apply cursor-based recovery and avoid sending unbounded high-rate UI telemetry.

## Push
Mobile notifications use service-worker-backed persistent notifications where supported. A push payload is an attention/deep-link signal, not canonical task truth. On notification open, mobile fetches the current task/event/artifact state.

## PWA
An installable PWA can improve launchability and shell caching where the browser/platform supports it. Installation is optional; core browser operation remains the compatibility baseline. Service-worker cache invalidation must be versioned so an updated FRIDAY client shell is not trapped behind stale assets.

## Compatibility tiers
- Tier 1: HTTPS, Chat, task observation/control, approvals, artifacts, reconnect.
- Tier 2: camera/microphone, WebRTC voice/media, push/service worker, enhanced device selection where supported.
- Tier 3: optional advanced browser/platform features.

The client advertises its actual capabilities. The server never assumes a browser supports a feature because its user-agent string claims a device family.

## Privacy
Never persist raw microphone/camera streams merely for UI convenience. Store only data required by FRIDAY's explicit memory/privacy policy. Device labels may be unavailable before permission; this is expected browser behavior.

## Sources
- MDN MediaDevices/getUserMedia: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- MDN Permissions API: https://developer.mozilla.org/en-US/docs/Web/API/Permissions_API
- W3C Permissions: https://www.w3.org/TR/permissions/
- W3C Permissions Policy: https://www.w3.org/TR/permissions-policy/
- W3C WebRTC: https://www.w3.org/TR/webrtc/
- MDN WebRTC protocols: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols
- MDN WebSocket: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
- MDN Push API: https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- MDN Notifications: https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API
