# Mobile Companion — Final Upgrade Blueprint

## 1. Product promise
The mobile browser is a complete remote FRIDAY surface, not a status viewer. From the phone, the user can connect to FRIDAY, converse in Chat or Voice, provide media/input, inspect and control work, approve governed actions, retrieve artifacts, change permitted mode/policy settings, and operate approved PC/FRIDAY capabilities without touching the PC.

## 2. Mobile information architecture
Primary surfaces: Home/Chat, Voice, Active Work, Approvals, Artifacts, Activity, Devices/Remote, Notifications, Settings/Security. Connection and permission status remain reachable without leaving FRIDAY.

## 3. Chat controls
Composer, attachments, voice handoff, camera/media input, stop/regenerate where valid, task creation/continuation, streaming, progress, approval cards, artifact cards, sources/evidence, steering, pause/resume/cancel, retry/reconnect states and conversation history.

## 4. Voice controls
Connect microphone, speaker/audio state, mute, push-to-talk/continuous mode where supported, barge-in, camera toggle, device selection where supported, live transcript/visual result surface, interruption state, network quality, session stop and fallback to text. Browser permission state is visible separately from FRIDAY session authority.

## 5. Work and governance
Task cards show objective, current state, step, evidence, waiting reason, owner decision required, controls and artifacts. Approval cards identify exact action, risk, target, scope, reason, expiration and approve/reject/inspect options. Approval is never inferred from a tap on an unrelated control.

## 6. Remote PC control
The remote-control surface identifies target device, active session, current authority, control scope, foreground/input priority, active action and stop/revoke controls. It never presents cached device state as live. High-risk actions enter the existing governance path.

## 7. Dynamic updates
On initial load, refresh and reconnect: negotiate protocol/schema versions → fetch runtime identity/capability catalog → fetch current permissions → obtain authoritative snapshot → reconcile event cursor → render current state. A service worker may cache the shell/assets, but must not pin runtime capability state beyond its freshness policy.

## 8. Connection choices
Same-network discovery, secure pairing/QR/code, previously trusted device, private remote-network route and manual connection fallback can be presented in one FRIDAY connection experience. Different-network privileged access should prefer a private overlay or equivalent authenticated transport rather than public exposure.

## 9. Mobile browser truth
Camera/microphone access requires a secure context and user permission. Browser permission, FRIDAY session authority, capability authorization and action governance are independent. If a browser lacks a feature, the UI shows a truthful fallback and preserves Chat/task functionality where possible.

## 10. Offline/reconnect
The phone may show cached read-only content with a stale marker. Mutations require a live authenticated session. Reconnect uses snapshot + cursor reconciliation and never replays a mutation merely because a socket was lost.
