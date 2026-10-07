# Capability Lifecycle

## Purpose
Give every capability a predictable lifecycle from discovery through retirement.

## Canonical flow
DISCOVERED → VALIDATED → REGISTERED → HEALTHY/DEGRADED → ACTIVE → QUARANTINED → RETIRED.

## Required contracts
Lifecycle events include version, manifest hash, health evidence, activation authority and retirement reason.

## Failure and recovery
Quarantine is reversible; retirement does not erase historical evidence.

## Implementation guidance
Use existing plugin/skill/module/connector registries through adapters.
