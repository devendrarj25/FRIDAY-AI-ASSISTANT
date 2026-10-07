# Canonical Event Fabric

## Purpose
Create one event envelope consumed by execution, UI, notifications, Companion, audit and observability.

## Canonical flow
Producer → event validation → durable/ephemeral classification → bus → subscribers → cursor/checkpoint.

## Required contracts
Event fields: event_id, type, timestamp, trace_id, conversation_id, task_id, action_id, source, schema_version, sensitivity, payload, evidence_refs.

## Failure and recovery
Out-of-order events use sequence/cursor reconciliation. Stale clients resync from checkpoint.

## Implementation guidance
Extend existing event-bus/bridge/streaming rather than creating a second bus.
