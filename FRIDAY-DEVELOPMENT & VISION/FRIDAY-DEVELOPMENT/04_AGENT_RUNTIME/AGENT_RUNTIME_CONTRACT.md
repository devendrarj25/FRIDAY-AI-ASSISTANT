# Agent Runtime Contract

An agent is a bounded worker attached to a parent task.

Manifest:
- stable id/version;
- role/mission;
- allowed capabilities;
- allowed data classes;
- authority scope;
- budget;
- time limit;
- memory scope;
- network policy;
- verification requirement.

Delegation must carry:
`parent_task_id, child_task_id, objective, scope, budget, authority, evidence, output contract`

Child agents cannot expand parent authority.

Parallelism requires conflict analysis and bounded shared-state access.
