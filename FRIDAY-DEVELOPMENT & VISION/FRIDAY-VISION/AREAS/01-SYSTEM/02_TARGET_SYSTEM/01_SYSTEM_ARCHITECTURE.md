# FRIDAY OS Target Architecture

## Purpose
FRIDAY is one persistent assistant system with multiple experience endpoints and operating modes. The architecture is a mesh of cooperating subsystems, not a fixed linear pipeline. A request may take a short path, a research path, a computer-use path, a multimodal path or a long-running durable workflow. The router chooses the smallest safe path that satisfies the objective.

## Canonical flow
Owner/Policy → Experience Ingress → Session/Continuity → Context Assembly → Intent/Objectives → Planner → Universal Router → Model/Agent/Capability Selection → Governance → Execution Fabric → Verification → Artifact/Result → Memory/Knowledge Update → Event/Notification → Idle/Follow-up → Learning/Evaluation.

## Required contracts
Every execution has stable `conversation_id`, `turn_id`, optional `task_id`, `plan_id`, `route_id`, `action_id`, `artifact_id`, `trace_id`, `policy_version` and `capability_version`. No subsystem invents competing identifiers.

## Failure and recovery
Failures are classified, checkpointed and routed through bounded recovery. A failed tool does not automatically imply failed task; the planner may substitute a capability or re-plan if policy permits.

## Implementation guidance
Integrate this model over existing `brain-engine`, task runtime, capability registry, model routing and governance. Do not replace the current application shell.
