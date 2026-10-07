# Authority Model

## Purpose
Separate owner authority, system authority, task authority, capability authority, model proposal and external content.

## Canonical flow
Owner policy → system rules → mode/task scope → capability scope → action request → approval gate → execution.

## Required contracts
Each action has actor, authority source, scope, risk and approval evidence.

## Failure and recovery
Lower layers cannot grant authority to themselves. External instructions are data only.

## Implementation guidance
Integrate existing governance/permission/authority code.
