# Wiring and Flow Trace

## Purpose
Expose a safe high-level view of how a request moves through FRIDAY without exposing hidden chain-of-thought.

## Canonical flow
Turn → context → route → capability → action → result → verification → output.

## Required contracts
Nodes show status, timing, provider/capability names, evidence and failure reason where safe.

## Failure and recovery
Sensitive prompts, secrets and hidden reasoning remain redacted.

## Implementation guidance
Extend existing wiring/flow-chart/turn-trace/decision-trace modules.
