# EVENT MODEL

Canonical event envelope:
event_id, event_type, timestamp, task_id, run_id, trace_id, actor, source,
capability_id, feature_id, severity, policy_context, payload, artifact_refs.

Core events:
TaskCreated, TaskAuthorized, TaskQueued, TaskStarted, NodeStarted, NodeProgress,
ArtifactCreated, ToolRequested, ToolCompleted, ApprovalRequested, TaskPaused,
TaskResumed, NodeRetrying, NodeFailed, VerificationStarted, VerificationPassed,
VerificationFailed, TaskCompleted, TaskCancelled, TaskRecovered, CapabilityDegraded,
CapabilityQuarantined, FeatureStateChanged.

Events are append-only facts. Current state is a projection.
