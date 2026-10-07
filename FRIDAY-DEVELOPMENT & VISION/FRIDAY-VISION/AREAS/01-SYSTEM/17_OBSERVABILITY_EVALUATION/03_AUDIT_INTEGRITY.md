# Audit Integrity

## Purpose
Keep an append-only evidence trail for privileged actions, self-changes, approvals and policy verification.

## Canonical flow
Authority decision → audit event → durable storage → hash/link integrity → query/export.

## Required contracts
Audit entries include actor, action, policy version, approval, target, result and evidence references.

## Failure and recovery
If audit integrity is broken, privileged operations fail closed according to policy.

## Implementation guidance
Reuse logs/debug/database backup architecture where appropriate.
