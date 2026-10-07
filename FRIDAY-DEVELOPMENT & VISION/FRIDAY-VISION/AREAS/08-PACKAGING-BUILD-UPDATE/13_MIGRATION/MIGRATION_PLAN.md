# Migration Plan

Phase 1 — Inventory
- map current install paths and runtime paths
- identify all files that are application-owned vs user-owned
- identify current updater behavior

Phase 2 — Registry
- introduce component/runtime ownership metadata
- migrate existing installed resources into registry records without moving user data unnecessarily

Phase 3 — Root layout
- establish the FRIDAY managed root and controlled staging/download paths
- preserve compatibility with existing installations

Phase 4 — Update transaction
- add journal, staging, verification, health checks and rollback

Phase 5 — Uninstall
- add ownership verification and two uninstall modes

Phase 6 — Release evidence
- unify CMD/GitHub build evidence and artifact verification

Phase 7 — Clean-machine validation
- execute the complete matrix before enabling broad automatic update.

Migration must be resumable and idempotent. Never require a one-shot destructive conversion of user state.
