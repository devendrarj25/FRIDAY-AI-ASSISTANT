# Learned Routing

## Purpose
Improve model/capability selection from historical success, latency, cost and user satisfaction while preserving policy constraints.

## Canonical flow
Route → outcome → score update → confidence → future candidate ranking.

## Required contracts
Scores are advisory; hard policy/compatibility filters always run first.

## Failure and recovery
Cold-start uses deterministic defaults; anomalous learning is capped and reversible.

## Implementation guidance
Integrate with model/capability health and cost policy.
