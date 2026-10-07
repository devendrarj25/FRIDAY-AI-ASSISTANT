# Resource-Aware Scheduler

The scheduler manages CPU, GPU, RAM, VRAM, disk, network, model concurrency, browser sessions and foreground interaction budget.

When constrained:
- reduce concurrency;
- route to smaller/local models;
- defer non-urgent background work;
- compact context;
- stream or chunk artifacts;
- pause low-priority tasks;
- preserve interactive latency.

No background “autonomy” is allowed to make the desktop unusable for the owner.
