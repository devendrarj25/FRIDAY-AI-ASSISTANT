# FEATURE REQUIREMENT ENGINE

A feature declares:
- user outcome
- triggers
- required inputs
- required capabilities
- optional accelerators
- data classes
- permission needs
- success predicates
- verification strategy
- UI/voice surfaces
- notification policy
- budgets
- degradation modes
- rollback strategy

The resolver computes:
READY / READY_WITH_DEGRADATION / BLOCKED / NEEDS_SETUP.

A feature must never appear "ready" merely because its UI exists.
