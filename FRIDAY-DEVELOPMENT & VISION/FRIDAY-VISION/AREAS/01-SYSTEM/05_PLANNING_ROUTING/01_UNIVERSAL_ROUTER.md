# Universal Router

## Purpose
Select the best safe execution path dynamically. The router can shorten, branch, skip or replace steps based on capability health, task constraints and observed results.

## Canonical flow
Objective → constraints → candidate paths → capability/model/tool scoring → policy filter → cost/latency estimate → select → execute → observe → re-route if needed.

## Required contracts
Route decision records candidates considered, selected path, rejection reasons, risk class, confidence, expected cost/latency and fallback options.

## Failure and recovery
Unavailable/slow/failing capabilities trigger bounded switching. Never switch to a capability that lacks policy scope or data access.

## Implementation guidance
Extend brain routing rather than creating a new orchestration framework.
