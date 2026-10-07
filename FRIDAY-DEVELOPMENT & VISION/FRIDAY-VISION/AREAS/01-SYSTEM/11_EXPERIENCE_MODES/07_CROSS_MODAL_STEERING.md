# Cross-Modal Steering

The owner can start in Chat, continue in Voice, inspect in Mobile and return to Chat without losing the task.

Operations that must be common:
- interrupt/cancel;
- pause/resume;
- approve/deny;
- change priority;
- add instruction;
- redirect a subtask;
- inspect current state;
- request evidence;
- open latest artifact/result.

A modal shell sends control commands to the same run/task authority. It never mutates state independently.
