# Distributed Companion Architecture

## Purpose
Keep the brain on the trusted FRIDAY host while remote endpoints connect through authenticated sessions.

## Canonical flow
Phone/remote endpoint → secure overlay → companion gateway → session broker → shared task/event fabric.

## Required contracts
Use short-lived session tokens, device binding, replay protection, cursor, capability scope and revocation.

## Failure and recovery
Never expose the full desktop or privileged IPC surface directly to the public internet.

## Implementation guidance
Reuse existing remote-access and companion implementations.
