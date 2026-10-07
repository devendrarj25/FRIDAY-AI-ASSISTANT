# Computer Use

## Purpose
Enable FRIDAY to operate the Windows desktop and browser through observable, capability-gated actions while keeping privileged operations brokered.

## Canonical flow
Observe screen/window → identify target → plan action → policy/risk check → input action → observe result → verify expected state.

## Required contracts
Every GUI action has target context, precondition, action, postcondition and optional screenshot evidence.

## Failure and recovery
Wrong-window, stale-screen and unexpected-dialog failures pause and re-observe. Destructive actions require the existing approval gate.

## Implementation guidance
Use current screen awareness, browser engine, live browser and Electron/kernel authority paths.
