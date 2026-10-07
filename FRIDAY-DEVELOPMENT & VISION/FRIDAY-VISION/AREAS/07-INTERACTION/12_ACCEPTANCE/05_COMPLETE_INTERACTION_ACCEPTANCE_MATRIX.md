# Complete Interaction Acceptance Matrix

## A. Common truth
- Same conversation/task survives Chat ↔ Voice ↔ Mobile handoff.
- Same task ID remains authoritative after renderer/browser reload.
- No UI state can claim completion without runtime evidence.

## B. Mobile connection
- Same-network pairing succeeds with authenticated identity.
- Private remote-network connection succeeds without public privileged exposure.
- Wrong/expired/revoked credentials fail closed.
- Reconnect reconciles snapshot/cursor without replaying mutations.

## C. Mobile Chat
- Text, attachments, artifacts, progress, approvals, steering, pause/resume/cancel and error recovery work where capability scope permits.
- New compatible runtime capabilities appear after refresh/reconnect without bespoke client edits.

## D. Mobile Voice
- Browser asks for microphone permission when needed.
- Camera permission is separate and explicit.
- Active media is verified, not inferred from a button state.
- Full-duplex/barge-in preserves task truth and invalidates stale speech generation.
- Unsupported browser behavior degrades to truthful text/control alternatives.

## E. Manual/Auto
- Manual gated work waits for explicit approval.
- Auto advances eligible low-risk work without fake UI clicks.
- Remote origin cannot elevate authority.
- Mode changes are auditable policy events.

## F. Remote control
- Device target and active session are visible.
- Commands are idempotent where appropriate.
- High-risk actions enter governance.
- Revoke blocks new commands.

## G. Browser lifecycle
- Refresh/reopen restores authoritative state.
- Service-worker cache cannot pin stale capability metadata beyond policy.
- Push notification opens the relevant authoritative task/artifact state.

## H. Performance
- Control/event latency is bounded under normal LAN and remote conditions.
- Audio remains responsive while tools/deep reasoning run asynchronously.
- Event queues remain bounded and recoverable.

## I. Regression
- Existing desktop Chat/Voice behavior is unchanged unless explicitly upgraded.
- Existing Manual/Auto semantics remain intact.
- Existing build/install/release flows remain untouched unless required and verified.
