# Cognitive Loop

## Purpose
Provide a human-like assistant experience through persistent identity, context, goals, affective signals, social calibration and reflective memory while keeping deterministic policy outside the model.

## Canonical flow
Observe → Understand → Contextualize → Set objective → Consider options → Select plan → Act → Observe result → Evaluate → Remember → Adapt.

## Required contracts
Cognitive state is typed: current objective, urgency, confidence, attention target, active commitments, affective posture, user interaction preference, uncertainty and next-best action.

## Failure and recovery
Low confidence triggers clarification, research or verification rather than invented certainty. Conflicting memories are reconciled with provenance and freshness.

## Implementation guidance
Extend existing identity/affect/context/reasoning/world-model modules.
