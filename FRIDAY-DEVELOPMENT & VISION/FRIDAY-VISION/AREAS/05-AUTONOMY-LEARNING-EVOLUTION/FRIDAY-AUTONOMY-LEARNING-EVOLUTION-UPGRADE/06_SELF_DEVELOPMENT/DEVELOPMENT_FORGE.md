# Self-Development Forge

FRIDAY already has forge modules. Upgrade them into a unified artifact compiler.

## Artifact types
- prompt
- policy
- memory rule
- procedure
- skill
- tool
- workflow
- agent
- module
- router rule
- local adapter
- code patch

## Common contract
Every artifact has:
`id, kind, version, parentVersion, author, generatedBy, dependencies, permissions, tests, metrics, lineage, rollback`

## Development loop
`Limitation → Hypothesis → Candidate → Static checks → Sandbox → Tests → Eval → Security → Review → Canary → Promote`

## Artifact-specific checks
### Skill
Schema + deterministic fixtures + permission audit.
### Tool
Input validation + timeout + network scope + least privilege.
### Workflow
Trace replay + cost/latency + failure recovery.
### Agent
Task benchmark + tool-use benchmark + stop-condition tests.
### Code
Unit/integration tests + static analysis + protected-file diff + rollback.
### Adapter
Holdout benchmark + regression suite + resource test.
