# Mobile Phone and Browser Compatibility Strategy

## Objective

The Mobile Companion is a standards-based web experience designed for broad modern mobile-browser coverage. It must be responsive and usable across common Android and iOS browsers while explicitly handling capability differences.

“Works everywhere” means:
- the core authenticated UI can load on supported modern browsers
- core text Chat has a broad fallback path
- unsupported optional APIs degrade gracefully
- browser-specific limitations are detected and surfaced
- no browser is falsely reported as fully capable

It does **not** mean every browser exposes identical hardware APIs.

## Compatibility tiers

### Tier 1 — Core
- HTTPS/secure origin
- HTML/CSS/JS
- authenticated session
- text Chat
- task state
- approvals
- artifacts
- capability discovery
- reconnect/reconciliation

### Tier 2 — Enhanced
- streaming events
- realtime voice
- camera
- file/media capture
- push notifications
- PWA installation

### Tier 3 — Advanced
- browser/device-specific remote media behavior
- background behavior
- optional screen/device APIs
- advanced local-network capabilities

Every tier has explicit detection and fallback.

## Browser capability matrix

The runtime should maintain capability facts for:
- browser family/version
- OS family/version where available without invasive fingerprinting
- secure context
- WebRTC
- getUserMedia
- camera
- microphone
- audio playback behavior
- notifications
- service worker
- push
- PWA installability
- local-network permissions where exposed
- supported media codecs
- viewport/touch/pointer features

Only capability facts relevant to FRIDAY behavior should be collected.

## Browser compatibility contract

The server may provide feature requirements, but the client decides whether the local browser can actually execute a browser-only primitive.

Never use user-agent sniffing as the only capability test.

Prefer:
1. API existence/feature detection
2. permission state where supported
3. actual initialization test
4. negotiated protocol/media capability
5. explicit fallback

## PWA

A PWA-style installable experience may be offered as an optional enhancement. Browser access remains the canonical compatibility path.

Installation must never be required to use core mobile Chat/approval/task functionality unless a specific browser capability genuinely requires an installed experience.

## Responsive UX

Adapt:
- navigation
- touch targets
- keyboard-safe composer
- bottom sheets
- full-screen media
- portrait/landscape
- safe areas/notches
- low-bandwidth presentation
- reduced-motion/accessibility settings

Do not fork FRIDAY semantics between phone browsers.

## Accessibility

Maintain:
- keyboard/switch accessibility where supported
- screen-reader semantics
- visible focus
- sufficient touch target size
- reduced-motion support
- text alternatives for visual outputs
- clear live-region handling for streamed responses
- non-color-only status indicators

## Performance

The shell must become interactive before large history/artifact data is hydrated. Use:
- snapshot-first bootstrap
- incremental task/history loading
- lazy artifact previews
- bounded event buffers
- backpressure for fast streams
- media quality adaptation
- reconnect without full-page reload when possible
