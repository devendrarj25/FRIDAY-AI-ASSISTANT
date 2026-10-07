# Background, Proactive Work and Notifications

## Background work
Assigned background tasks are durable task graph work. They use resource budgets, checkpointing, recovery and the same event fabric.

## Proactive behavior
FRIDAY may surface a proactive event only when an existing goal, commitment, task, threshold, deadline or useful observation creates a concrete reason. Avoid generic “AI chatter”. Use an interruption-value filter: urgency, consequence, confidence, actionability and owner preference.

## Manual behavior
A notification can say “approval required”, “task completed”, “new evidence”, or “failure needs attention”. It must not imply that the owner already approved an action.

## Auto behavior
Permitted actions may continue silently while significant milestones/errors/approvals are emitted. High-risk steps pause at the same approval boundary.

## Resource safety
Background work yields to foreground interactions according to the existing resource governor. Auto must never starve the desktop or make the UI unresponsive.
