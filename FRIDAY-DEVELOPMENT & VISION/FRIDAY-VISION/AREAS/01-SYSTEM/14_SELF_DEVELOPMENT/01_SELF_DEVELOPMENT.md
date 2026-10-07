# Self-Development Architecture

## Purpose
Allow FRIDAY to identify defects, propose code changes, implement them in isolation, test them and prepare a candidate release without direct production mutation.

## Canonical flow
Detect → diagnose → create proposal → isolated worktree/sandbox → edit → lint/typecheck/tests → build → targeted runtime checks → review/risk → canary → promote/rollback.

## Required contracts
Proposal includes target files, reason, expected behavior, dependency impact, risk, tests, rollback plan and evidence.

## Failure and recovery
Any build/release failure blocks promotion. Production source is immutable to the candidate until explicit governance approval.

## Implementation guidance
Extend dev-pipeline, self-maintenance, builder and release manager; protect CI/release paths.
