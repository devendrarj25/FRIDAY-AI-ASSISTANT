# Local/Cloud Data Boundary

## Purpose
Select execution location based on data sensitivity, availability, performance and explicit user/provider policy.

## Canonical flow
Data classification → eligible locations → model capability → health → route.

## Required contracts
Every model request carries a data-classification decision and allowed egress scope.

## Failure and recovery
When no eligible model exists, ask for approval or provide a degraded local response rather than silently violating policy.

## Implementation guidance
Integrate provider registry, privacy firewall and secrets boundary.
