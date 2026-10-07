# Idempotency and Side Effects

## Purpose
Make retries safe by assigning stable action keys and reconciling external state before replay.

## Canonical flow
Prepare key → check prior result → execute once → persist evidence → reconcile if uncertain.

## Required contracts
Side-effect class determines whether automatic retry is allowed.

## Failure and recovery
Unknown outcome for a payment/file deletion/system change requires reconciliation or approval, not blind retry.

## Implementation guidance
Add contracts to execution/action risk and task ledger.
