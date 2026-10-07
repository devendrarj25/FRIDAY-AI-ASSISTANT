# Autonomy Scheduling and Yielding

Auto work participates in the existing scheduler/resource governor. Foreground owner interaction receives appropriate priority. Background tasks can be paused or degraded under CPU/GPU/memory pressure.

Long-running tasks yield at safe checkpoints. A task that cannot safely yield must declare that fact to the scheduler and remain bounded by execution leases/timeouts.

Self-learning/self-development/self-evolution remain existing FRIDAY subsystems; the interaction layer only provides task/notification/approval surfaces and never creates a second scheduler.
