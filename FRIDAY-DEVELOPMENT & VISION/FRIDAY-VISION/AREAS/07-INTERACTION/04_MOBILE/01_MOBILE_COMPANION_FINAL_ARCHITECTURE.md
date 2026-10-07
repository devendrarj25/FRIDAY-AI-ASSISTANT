# Mobile Companion — Final Remote Experience Architecture

Mobile is a remote endpoint to the same FRIDAY instance. It is not a second assistant, second database, or second scheduler.

## Connection model
`device identity → authenticated session → private overlay transport → companion bridge → runtime snapshot/cursor → shared task/event system`.

Different-network access should prefer a private overlay such as Tailscale/WireGuard-style networking. Public exposure of privileged FRIDAY control is not the baseline architecture.

## Mobile capabilities
- send a new instruction
- continue an existing conversation/task
- inspect live task state
- receive streamed progress
- approve/reject gated actions
- pause/resume/cancel permitted tasks
- change priority or provide steering instructions
- request evidence
- retrieve/open latest artifacts
- receive notifications for important state changes

## Capability scoping
The companion session has device identity, owner identity, session expiry, capability scope and policy version. A mobile command is checked at the same authority boundary as a desktop command.

## Reconnect
Mobile never replays a command just because the network was interrupted. It reconnects, receives authoritative snapshot/version, reconciles cursor gaps, then resumes observation. Mutating commands use idempotency keys and are retried only when their semantics allow it.

## Offline behavior
Read-only cached state may be shown as stale. No cached state is treated as current truth. Sensitive or mutating commands require an authenticated live session.
