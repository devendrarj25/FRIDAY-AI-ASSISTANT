# Trace Model

## Purpose
Use OpenTelemetry-compatible concepts for traces, spans, events and metrics while retaining FRIDAY-specific IDs.

## Canonical flow
Trace → turn span → plan spans → model/capability/action spans → verification → artifact.

## Required contracts
Propagate trace/context IDs through Electron, kernel, agent workers, connectors and Companion.

## Failure and recovery
Telemetry failures must not block user work except where audit integrity is a hard requirement.

## Implementation guidance
Extend current turn-trace/decision-trace/log-stream and adopt stable semantic fields.
