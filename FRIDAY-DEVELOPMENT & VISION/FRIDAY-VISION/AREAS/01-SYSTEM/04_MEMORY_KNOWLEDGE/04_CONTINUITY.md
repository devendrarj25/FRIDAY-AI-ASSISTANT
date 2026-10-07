# Cross-Conversation Continuity

## Purpose
A conversation is an experience surface; durable task and memory state survives across Chat, Voice, Companion and restarts.

## Canonical flow
Endpoint event → shared session/task identity → durable state → other endpoint subscribes → resync from checkpoint.

## Required contracts
Continuity records reference canonical IDs and provenance, never UI-specific state.

## Failure and recovery
Stale clients receive snapshot + event cursor and reconcile instead of replaying unsafe actions.

## Implementation guidance
Extend existing cross-mode sync, companion-live, persist and task ledger.
