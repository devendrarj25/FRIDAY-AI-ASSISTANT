# Self-Repair and Doctor Loop

## Purpose
Diagnose health failures, apply minimal repairs and verify the exact symptom without turning diagnostics into uncontrolled code mutation.

## Canonical flow
Health signal → diagnosis → repair candidate → policy/risk → isolated repair → verification → recovery record.

## Required contracts
Repair records exact symptom, hypothesis, touched files, commands, tests and rollback point.

## Failure and recovery
If confidence is low or scope expands, stop and escalate instead of guessing.

## Implementation guidance
Use doctor-engine, diagnostics, logs, health and existing repair scripts.
