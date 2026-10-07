# Dynamic Capability Composition

## Purpose
Compose multiple capabilities into a temporary workflow when no single capability satisfies the objective.

## Canonical flow
Goal decomposition → capability search → compatibility graph → compose → validate permissions → execute → verify.

## Required contracts
Composition is runtime state; successful compositions may become candidate workflows only after evaluation.

## Failure and recovery
If a component fails, substitute only a capability with compatible contract and authority scope.

## Implementation guidance
Reuse workflow forge/router and capability registry.
