# Goal Graph, Convoy and Parallel Work

Represent complex work as a dependency graph of goals/tasks/steps with explicit inputs, outputs, blockers and verification conditions.

A convoy is a coordinated set of independent or dependent work units that can run in parallel under one parent goal. The scheduler decides:
- parallel vs serial execution;
- resource budget;
- model/capability assignment;
- deadline and priority;
- cancellation propagation;
- approval dependencies;
- artifact dependencies.

No subtask is marked complete merely because an agent produced text. Completion requires the declared evidence predicate.
