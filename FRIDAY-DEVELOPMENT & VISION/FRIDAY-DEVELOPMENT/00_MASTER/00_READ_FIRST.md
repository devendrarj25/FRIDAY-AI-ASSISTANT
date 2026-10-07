# Read first — development

Repo-root order is `AGENTS.md`, then `READMEFIRST.md`, then this file.
Use this order inside the development layer.

1. Read `00_MASTER/DEVELOPMENT_MASTER_CONTRACT.md`.
2. Classify the task using `01_SOURCE_ROUTING/TASK_TO_AREA_ROUTER.md`.
3. Open only the relevant source card(s).
4. Resolve the canonical owner file.
5. Read direct dependencies and existing tests only.
6. Inspect adjacent contracts if the change crosses a boundary.
7. Implement the smallest compatible change.
8. Run focused validation first.
9. Run boundary/regression validation when required.
10. Record the change in the change ledger.

Never:
- create a parallel registry when a canonical registry exists;
- create a second memory/task/router/authority implementation;
- silently delete existing behavior;
- call a planned feature implemented without code/test evidence;
- use a model response as proof that an external side effect happened.

## Related
If the task needs a design that doesn't exist in the current app yet (a
future/major upgrade, not a fix to something present today), continue to
`../../FRIDAY-VISION/00-MASTER/00_READ_FIRST.md` and read only the one
matching target area — not the whole vision tree. Repo-root overview:
`../../../READMEFIRST.md`.
