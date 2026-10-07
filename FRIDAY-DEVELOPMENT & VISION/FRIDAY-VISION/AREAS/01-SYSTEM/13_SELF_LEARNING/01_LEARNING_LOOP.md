# Self-Learning Loop

## Purpose
Learn from explicit user feedback, task outcomes, routing outcomes and verified observations without changing immutable policy.

## Canonical flow
Outcome → evaluate success → classify cause → candidate learning → validate → store learned preference/policy-compatible strategy → measure later.

## Required contracts
Learning records source, confidence, scope, expiration and whether it is user preference, routing heuristic, skill knowledge or system diagnostic.

## Failure and recovery
Bad learning can be rolled back or decayed; safety/policy never enters the learned mutable layer.

## Implementation guidance
Extend learning-engine, memory-consolidate, benchmark and mastery.
