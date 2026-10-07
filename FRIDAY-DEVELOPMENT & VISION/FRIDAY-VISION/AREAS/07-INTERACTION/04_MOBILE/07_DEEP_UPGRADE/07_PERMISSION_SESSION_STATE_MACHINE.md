# Mobile Permission and Session State Machines

## Browser capability state

```text
unknown
  ↓ detect
unsupported ───────────────→ fallback
  ↓ supported
permission_unknown
  ↓ query (when supported)
prompt ── user gesture ──→ requesting
requesting ───────────────→ granted
requesting ───────────────→ denied
granted ── init ──→ active
active ── stop ──→ released
denied ── recovery ──→ prompt (only when browser permits)
```

The UI must not repeatedly prompt after denial.

## Connection state

```text
idle
 ↓
discovering
 ↓
pairing
 ↓
authenticating
 ↓
authorizing
 ↓
snapshot_sync
 ↓
cursor_reconcile
 ↓
stream_connect
 ↓
connected
 ↓
degraded
 ↓
reconnecting
```

Terminal failures must preserve diagnostic reason and recovery action.

## Session authority

```text
authenticated
→ scoped
→ active
→ expiring
→ reauth_required
→ revoked/expired
```

A browser tab being open does not imply an active authorized session.

## Media session

```text
idle
→ requested
→ permission_granted
→ device_initializing
→ negotiating
→ live
→ degraded
→ stopped
```

Only `live` may be presented as actively transmitting/receiving media.

## Remote command

```text
created
→ validated
→ authorized
→ approval_required? 
→ approved
→ dispatched
→ executing
→ verifying
→ succeeded / failed / unknown
```

If the result is `unknown`, reconcile before retrying.

## Approval

```text
pending
→ displayed
→ owner_decision
→ approved / rejected / expired / revoked
```

Approval state is durable/canonical; a mobile card is only its projection.
