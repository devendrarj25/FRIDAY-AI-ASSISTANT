# Auto refresh / reconciliation

## Refresh layers

1. Provider manifest version.
2. Credential/auth status.
3. Model catalogue.
4. Model detail metadata.
5. Pricing/limits.
6. Lifecycle/deprecation.
7. Endpoint health.
8. Local runtime inventory.
9. Local artifact integrity.

## Scheduling

- startup: quick health + stale catalogue check
- foreground: on-demand refresh when user opens Models
- background: provider-specific interval with jitter
- after failure: targeted refresh
- before routing: refresh only when snapshot is stale enough to matter

Never refresh every provider on every chat turn.

## Atomic snapshot

Write a new snapshot to a temporary generation, validate it, then swap the pointer. If refresh fails, keep the previous good generation.
