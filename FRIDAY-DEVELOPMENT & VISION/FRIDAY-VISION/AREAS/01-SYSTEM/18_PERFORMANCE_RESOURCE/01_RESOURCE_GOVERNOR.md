# Resource Governor

## Purpose
Budget CPU, memory, GPU, network, model calls, disk and concurrent tasks so autonomy does not starve the desktop.

## Canonical flow
Task request → resource estimate → admission control → execution → live usage → throttle/preempt/degrade.

## Required contracts
Budgets are per task, per capability and system-wide with priority classes.

## Failure and recovery
When resources are constrained, reduce concurrency or quality before violating safety/data policy.

## Implementation guidance
Integrate existing performance/health/resource code.
