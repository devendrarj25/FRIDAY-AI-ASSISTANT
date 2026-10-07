# World Model

## Purpose
Maintain a structured model of FRIDAY, the user's approved environment, active projects, devices, tasks, services and external entities. Facts are provenance-bearing and time-sensitive.

## Canonical flow
Observe → normalize entity → resolve identity → merge fact → score freshness/confidence → expose relevant slice to planner.

## Required contracts
Facts require source, observed_at, valid_until/refresh policy, confidence, sensitivity and entity identity.

## Failure and recovery
Contradictory observations create reconciliation records rather than silently overwriting trusted facts.

## Implementation guidance
Extend existing world-model, project identity, device awareness and system context.
