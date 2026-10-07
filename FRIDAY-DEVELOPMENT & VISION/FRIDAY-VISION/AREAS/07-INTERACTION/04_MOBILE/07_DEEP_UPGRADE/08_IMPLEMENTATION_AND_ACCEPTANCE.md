# Mobile Deep Upgrade — Implementation and Acceptance

## Source ownership to reuse

Before changing source, locate and reuse the existing owners for:
- companion/bridge
- cross-mode sync
- capability registry
- task graph/ledger
- governance
- event fabric
- notifications
- voice state/audio/STT
- browser/live browser
- screen/camera awareness
- authentication/remote access
- artifact handling
- IPC/kernel authority

Do not create parallel registries, task stores, event buses, permission stores, or remote-command executors.

## Required implementation slices

### Slice A — Connection and trust
Implement/extend existing companion connection, pairing, authentication, session scope and revocation.

### Slice B — Capability synchronization
Expose authoritative capability/schema/version metadata through the existing registry/bridge. Render through generic mobile components.

### Slice C — Realtime state
Connect mobile to the existing event fabric with cursor/version reconciliation and safe reconnect.

### Slice D — Chat parity
Expose the full compatible Chat control/result surface through the existing shared Brain path.

### Slice E — Voice parity
Expose browser media permission, realtime voice, barge-in and visual/voice coordination through existing Voice owners.

### Slice F — Governance
Project approval requests and decisions; route decisions through existing governance.

### Slice G — Remote control
Reuse existing remote-access/device-control authority; do not invent a mobile-specific shell/control executor.

### Slice H — Artifacts/output
Reuse canonical artifact/result contracts and mobile rendering matrix.

### Slice I — Browser capability degradation
Implement feature detection and explicit fallbacks.

## Acceptance

### Connection
- same-network pairing works
- private remote connection works where configured
- authentication is required
- revocation takes effect
- partial connection states are visible

### Chat
- text turn starts from mobile
- streaming result appears
- same conversation is visible on PC
- task continuation works
- artifact appears
- approval appears and can be decided
- result is verified before success

### Voice
- microphone permission prompt is user-triggered
- denied permission produces recovery state
- granted permission creates a live media state
- voice can be interrupted
- visual result appears alongside spoken summary
- voice failure falls back appropriately
- no false “speaking/listening” status

### Tasks
- start/observe/steer permitted task
- disconnect during task
- reconnect without duplicate mutation
- recover missed event/cursor
- retrieve final artifact

### Remote control
- authorized operation executes
- unauthorized operation is blocked
- high-risk action reaches governance
- result/evidence is shown
- unknown outcome reconciles before retry

### Upgrade freshness
- install/update a compatible capability on PC
- reconnect/refresh mobile
- capability catalog/version changes
- new compatible capability becomes available without a bespoke mobile implementation
- unsupported/new protocol state is clearly marked

### Browser matrix
Test representative current Android Chromium, Android Firefox, Android Samsung Internet/other supported Chromium variant, iOS Safari, and iOS third-party browser engines where available. Record capability differences rather than forcing identical behavior.

### Regression
Run only the minimum relevant existing tests/typechecks/build/boot checks needed to prove the changed path, plus the protected build/install/release checks if the implementation touched protected areas.
