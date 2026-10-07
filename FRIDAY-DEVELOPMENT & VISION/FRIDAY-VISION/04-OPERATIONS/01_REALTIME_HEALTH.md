# Realtime Health and Refresh

FRIDAY should expose one unified health model.

## States
`healthy | degraded | downloading | installing | verifying | update-available | incompatible | corrupted | repair-required | stopped`.

## Health domains
- app process
- kernel
- model provider
- runtime
- component
- storage
- network
- update service

## Refresh
Install/update completion emits an event; registry indexes refresh from authoritative manifests. The UI should not require a full restart unless the changed resource cannot be hot-activated.

## Performance
Avoid polling every subsystem aggressively. Use event-driven updates with bounded health probes and periodic reconciliation.
