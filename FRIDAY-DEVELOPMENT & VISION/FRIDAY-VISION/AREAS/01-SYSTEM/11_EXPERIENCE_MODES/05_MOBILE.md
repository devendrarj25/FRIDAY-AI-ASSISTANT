# Mobile Companion Experience Contract

## Purpose
Mobile is a remote experience endpoint, not a duplicate backend.

## Canonical flow
Authenticated session → event cursor/snapshot → input/task control → shared execution → realtime result.

## Required contracts
Companion session carries device identity, network path, auth state, cursor and capability scope.

## Failure and recovery
Network loss pauses only unsafe operations; reconnect resumes from checkpoint.

## Implementation guidance
Extend companion-live, bridge, remote-access and Tailscale/WireGuard-style private overlay.
