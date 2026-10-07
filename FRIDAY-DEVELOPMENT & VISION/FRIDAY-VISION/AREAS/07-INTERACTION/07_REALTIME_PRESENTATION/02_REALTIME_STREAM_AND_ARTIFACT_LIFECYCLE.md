# Realtime Stream + Artifact Lifecycle

## Stream types
- text delta
- voice/audio frame
- task status update
- progress milestone
- tool/capability event
- approval request/update
- artifact created/updated/finalized
- verification update
- error/recovery update

## Ordering
Every event carries task/session/turn/generation/version/cursor metadata sufficient to reject stale or duplicated events.

## Artifact lifecycle
`planned → generating → partial → verified/ready → superseded → archived/expired`

A partial artifact must not be presented as final unless its contract explicitly says partial output is acceptable.

## Reconnect
Clients resume from cursor when possible; otherwise obtain authoritative snapshot plus subsequent events.

## Voice generation safety
Audio playback is bound to generation identity. When superseded by a new user turn, stale audio must stop/duck and cannot continue as if it were current.
