# Recovery and Replanning

## Purpose
Recovery is evidence-driven and can change the route while preserving the original objective and policy constraints.

## Canonical flow
Failure → classify → recoverable? → retry/substitute/replan/rollback/escalate.

## Required contracts
Recovery record references original action, evidence and replacement route.

## Failure and recovery
Never hide repeated failure behind endless retries.

## Implementation guidance
Integrate bounded-retry, doctor, router and task runtime.
