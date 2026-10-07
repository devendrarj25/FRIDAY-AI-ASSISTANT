# Self-Growth Engine

Self-growth answers: **What should FRIDAY become better at next?**

## Inputs
- capability matrix
- failure clusters
- user goals
- repeated requests
- unresolved limitations
- new tools/models available
- research opportunities
- performance drift

## Capability graph
Replace a flat domain list with hierarchical capabilities:

`Research → WebResearch → SourceVerification → CitationSynthesis`
`Coding → RepoNavigation → PatchGeneration → TestRepair → Refactoring`
`Planning → GoalDecomposition → Scheduling → Replanning → DeadlineManagement`

Each node tracks:
- observed success
- evaluator score
- sample count
- confidence interval
- freshness
- preferred strategies
- known failure modes
- prerequisites

## Growth priority score
`priority = user_value × weakness × recurrence × feasibility × expected_gain / expected_cost`

Do not optimize capabilities the user never needs just because they are measurable.
