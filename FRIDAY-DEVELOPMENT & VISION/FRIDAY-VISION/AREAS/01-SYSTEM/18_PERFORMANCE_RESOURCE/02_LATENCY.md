# Latency Intelligence

## Purpose
Track end-to-end latency and component contributions so routing can choose better paths.

## Canonical flow
Ingress timestamp → spans → model/tool/action timings → output timestamp → budget analysis.

## Required contracts
Record p50/p95/p99 by capability/model/task class without retaining unnecessary payloads.

## Failure and recovery
Latency regressions become health/evaluation signals, not automatic permission to bypass verification.

## Implementation guidance
Use existing live metrics and timing modules.
