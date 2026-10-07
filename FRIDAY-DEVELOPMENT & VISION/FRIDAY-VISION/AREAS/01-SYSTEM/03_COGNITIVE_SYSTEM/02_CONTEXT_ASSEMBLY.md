# Context Assembly and Attention

## Purpose
Build the smallest useful context from conversation, task state, memory, current world state, active artifacts, capability metadata and policy constraints. Context is assembled per decision, not copied wholesale.

## Canonical flow
Current turn → recent conversation → task checkpoint → relevant memory → current system/device state → retrieved knowledge → capability summaries → policy constraints → model-specific context.

## Required contracts
Each context item has source, freshness, confidence, sensitivity, token/size cost and inclusion reason.

## Failure and recovery
Stale or conflicting data is marked; secrets and protected data are redacted unless the authorized capability explicitly requires them.

## Implementation guidance
Use the existing context-engine, retrieval and memory policy surfaces.
