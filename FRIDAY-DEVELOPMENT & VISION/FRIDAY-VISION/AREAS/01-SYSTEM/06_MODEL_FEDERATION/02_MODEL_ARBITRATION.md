# Model Arbitration and Ensembles

## Purpose
Use a judge/critic/verification model only when the task's value justifies the cost. Avoid redundant model calls for simple work.

## Canonical flow
Primary model → optional critic/verifier → evidence comparison → confidence update → final response/action.

## Required contracts
Arbitration records model IDs, evidence references, disagreement type and decision rule.

## Failure and recovery
No model can override policy. A verifier can reject or request more evidence, not directly execute privileged work.

## Implementation guidance
Implement as a planner option rather than a mandatory chain.
