# Adaptive Planner and Replanner

## Purpose
Use plans as mutable execution graphs rather than fixed scripts. Replanning is triggered by evidence, not arbitrary model indecision.

## Canonical flow
Goal → DAG/graph → execute ready nodes → checkpoint → observe evidence → satisfy/continue/replan/abort.

## Required contracts
Plan nodes have preconditions, postconditions, idempotency key, side-effect class, timeout, retry policy and compensation strategy.

## Failure and recovery
A failed node can be retried, substituted, compensated or escalated depending on failure class.

## Implementation guidance
Integrate with task graph/ledger and existing orchestrator.
