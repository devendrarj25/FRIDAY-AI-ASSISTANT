# Mobile Connection, Pairing and Remote Access UX

## Goal

The owner should be able to connect the phone to FRIDAY from the FRIDAY experience itself without hunting through unrelated configuration pages.

## Connection entry

The mobile connection surface provides:
- Find FRIDAY
- Same-network connection
- Private remote connection
- QR pairing
- pairing code
- trusted device selection
- connection diagnostics
- reconnect
- disconnect
- revoke this device
- session expiration/re-authentication

## Pairing

Recommended flow:

`Connect → discover/select FRIDAY → verify instance identity → QR/code confirmation → authenticate owner/device → choose session scope → connected`

Pairing should establish a cryptographic/trusted device relationship where the implementation supports it. A QR/code is a bootstrap mechanism, not the sole long-term authorization.

## Same-network

Use local discovery or an explicit local connection path where supported. The browser must still satisfy its own security constraints. Do not assume arbitrary local-network access is available from every browser.

## Different-network

Prefer a private authenticated overlay or equivalent secure relay architecture. The FRIDAY application authorization layer remains mandatory even when the network layer permits connectivity.

The architecture should not require public exposure of privileged FRIDAY ports as the default.

## Connection status

Always distinguish:
- network reachable
- authenticated
- FRIDAY runtime healthy
- session authorized
- event stream live
- media connected
- remote-control capability authorized

One green “Connected” label must never hide a partially failed state.

## Remote control

The remote-control screen must show:
- target PC/FRIDAY instance
- control session state
- who currently owns interactive control
- permissions/scope
- active operation
- stop/revoke
- safety/approval state
- evidence/result

Remote screen observation is not equivalent to remote control authority.

## Lost connection

A network loss does not automatically cancel a durable FRIDAY task. Task policy decides whether execution continues. Mobile reconnects and reconciles.

## Security boundary

Network access ≠ FRIDAY authority.
Mobile browser permission ≠ FRIDAY authority.
Session authentication ≠ approval.
Approval ≠ successful execution.
UI state ≠ verified truth.
