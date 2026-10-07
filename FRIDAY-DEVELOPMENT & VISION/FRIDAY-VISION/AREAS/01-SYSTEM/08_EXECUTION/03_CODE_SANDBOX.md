# Code and Developer Sandbox

## Purpose
Self-development and data analysis require isolated execution with explicit workspace, dependency, network and filesystem boundaries.

## Canonical flow
Create sandbox → mount approved workspace → run → collect artifacts/logs → tests → destroy or retain evidence.

## Required contracts
Sandbox profile defines allowed roots, network mode, command allowlist/denylist, CPU/memory/time budget and secret exposure.

## Failure and recovery
Sandbox escape or policy violation fails closed and records a security event.

## Implementation guidance
Extend current sandbox/sandbox-lab/sandbox-command and builder workflows; do not introduce an ungoverned executor.
