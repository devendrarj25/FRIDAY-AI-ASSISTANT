# Backward Compatibility

- Existing IDs remain valid.
- Legacy manifests get `schemaVersion: 1`.
- Adapter emits canonical schema v2.
- No UI route disappears during migration.
- Existing IPC methods remain available until consumers migrate.
- Feature flags allow per-capability rollout.
- Every cutover has a rollback switch.
