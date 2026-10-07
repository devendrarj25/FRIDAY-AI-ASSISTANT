# Live Activity Surface

## Purpose
Show what FRIDAY is actually doing: planning, waiting, tool execution, browser actions, file generation, verification, recovery and completion.

## Canonical flow
Execution event → state projection → current activity → historical steps → evidence/outputs.

## Required contracts
Activity state references task/action IDs and must be reconstructable from events.

## Failure and recovery
If events are missing, show unknown/stale state rather than inventing progress.

## Implementation guidance
Feed current HUD/stage/wiring surfaces; do not redesign them.
