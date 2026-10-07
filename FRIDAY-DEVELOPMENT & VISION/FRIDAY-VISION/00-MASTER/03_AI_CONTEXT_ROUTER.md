# AI Context Router

This is the mechanism for saving AI context/tokens without sacrificing correctness.

## Query-to-context algorithm
1. Classify task: system / brain / memory / model / capability / interaction / packaging.
2. Read the relevant area index.
3. Read only the relevant area master documents.
4. Resolve source owners using FILE-ROUTING-MAP.
5. Search symbol/import/caller relationships.
6. Read direct dependencies.
7. Read tests that encode the behavior.
8. Expand to adjacent areas only if a contract is crossed.
9. Before editing, build a change-impact set.
10. After editing, verify only affected gates first, then broader gates.

## Context tiers
Tier 0: master index and contracts.
Tier 1: requested area's plan.
Tier 2: exact source owners.
Tier 3: direct dependencies/tests.
Tier 4: cross-area owners.
Tier 5: full repository only for explicitly global changes.

## Landed areas
If an area directory is gone, read the product owner named in `00-MASTER/INDEX.md`. Do not recreate the plan.

## Never
- load every file by default
- assume a plan is implemented
- create duplicate infrastructure because a file was not initially opened
- rewrite unrelated areas
