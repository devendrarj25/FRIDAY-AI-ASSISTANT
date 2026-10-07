# Memory OS

## Purpose
Use layered memory: ephemeral turn context, working task state, episodic experiences, semantic facts, procedural skills, user preferences, project knowledge and archival records.

## Canonical flow
Capture event → classify → validate → consolidate → index → retrieve → use → outcome → reinforce/decay.

## Required contracts
Every memory has provenance, confidence, sensitivity, source, created/updated times, retention policy and deletion semantics.

## Failure and recovery
Incorrect or stale memory is quarantined and corrected through provenance-aware reconciliation. Sensitive memory is never inferred into durable storage without an allowed reason.

## Implementation guidance
Map onto existing `memory/`, brain memory engine, knowledge base, vector index and consolidation code.
