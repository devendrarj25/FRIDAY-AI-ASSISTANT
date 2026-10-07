# Fallback and Circuit-Breaker Fabric

## Purpose
Provide predictable fallback across model, provider, tool, connector, browser, network and artifact engines.

## Canonical flow
Failure → classify → increment health/circuit state → choose compatible fallback → reauthorize if risk changes → continue or escalate.

## Required contracts
Fallback must preserve task objective and security scope. Record when fallback changes model, provider, data location or execution authority.

## Failure and recovery
Repeated failures open a circuit and schedule health recovery instead of hammering the failing dependency.

## Implementation guidance
Use bounded retry and existing health/cooldown logic as inputs.
