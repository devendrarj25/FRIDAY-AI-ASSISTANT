# AI Upgrade Protocol

Use this protocol whenever an AI agent is asked to upgrade FRIDAY. Owner-requested upgrades of a planned area also follow Research-led upgrades in [AGENTS.md](../../../AGENTS.md).

### A. Understand
- Restate the requested behavior as acceptance criteria.
- Identify the owning area.
- Check the dependency map.

### B. Inspect
- Locate exact source owners.
- Inspect current implementation and tests.
- Identify existing mechanisms before creating anything new.

### C. Design
- Define contracts.
- Define state ownership.
- Define failure/rollback behavior.
- Define migration impact.
- Define performance constraints.

### D. Implement
- Make minimal coherent changes.
- Preserve existing public contracts unless deliberately versioned.
- Do not duplicate managers/registries.

### E. Verify
- typecheck/lint where applicable
- focused unit/integration tests
- startup/boot tests
- clean-machine tests for lifecycle changes
- security/permission tests for authority changes

### F. Retire the plan
When the upgrade is in the product and its tests pass, delete that area's
files from `FRIDAY-DEVELOPMENT & VISION` in the same change and point the
indexes at the product owner. Leave a plan in place only while its behaviour
is still absent from the code.

### G. Report
Return:
- files changed
- behavior changed
- tests run
- known limitations
- migration requirements
- rollback plan
