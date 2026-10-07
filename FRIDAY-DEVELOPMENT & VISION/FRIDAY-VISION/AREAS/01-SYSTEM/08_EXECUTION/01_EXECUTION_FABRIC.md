# Execution Fabric

## Purpose
Provide a common broker for filesystem, shell, PowerShell, browser, GUI, code, device, network and external-system actions.

## Canonical flow
Approved action envelope → authority broker → sandbox/profile → execute → capture stdout/stderr/screenshots/files/network evidence → verify → emit event.

## Required contracts
Action includes target, capability, scope, risk, approval, timeout, resource limits, idempotency and evidence requirements.

## Failure and recovery
Execution failure is typed. Partial side effects require reconciliation or compensation before task completion.

## Implementation guidance
Extend Electron tool authority, sandbox, kernel tools and existing terminal/device/browser engines.
