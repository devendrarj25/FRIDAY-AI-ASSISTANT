# Private Remote Networking

## Purpose
Prefer private overlay networking such as Tailscale/WireGuard for off-LAN access, with FRIDAY still enforcing application-level authorization.

## Canonical flow
Private network identity → TLS/application auth → companion session → capability scope.

## Required contracts
Network membership is not equivalent to owner authorization.

## Failure and recovery
A revoked device must lose application access even if it remains on the overlay.

## Implementation guidance
Use existing network/off-LAN probes and remote-access code.
