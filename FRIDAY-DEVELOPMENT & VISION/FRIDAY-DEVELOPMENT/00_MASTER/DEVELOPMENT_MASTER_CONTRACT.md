# Development Master Contract

## Architecture law
FRIDAY is one connected system. Existing modules are extended before new subsystems are invented.

Canonical conceptual loop:

`Observe → Understand → Retrieve → Plan → Authorize → Execute → Verify → Record → Learn`

Canonical control boundaries:

- Experience/UI: presentation and user interaction.
- Supervisor/orchestrator: task coordination.
- Brain/cognition: interpretation, reasoning and planning.
- Model router: model/provider selection.
- Agent runtime: bounded delegation.
- Capability fabric: skills/tools/modules/connectors/workflows.
- Authority: permissions and approvals.
- Execution: side effects.
- Verification: independent postcondition checks.
- Evidence: durable proof/provenance.
- Memory/knowledge: durable meaning, not raw transcript.
- Observability/evaluation: runtime evidence and quality measurement.
- Self-improvement: governed change proposals, not unrestricted mutation.

## Compatibility law
The existing 17-layer FRIDAY flow remains the compatibility spine. New contracts must map to existing owners.

## Ownership law
Every behavior has one canonical owner. New code must reference that owner instead of duplicating it.

## Preservation law
Existing UI, build, installer, registries, governance, privacy, memory and runtime behavior are preserved unless the task explicitly changes them and regression tests prove the change.

## Evidence law
A successful model response is not evidence of a successful external action.

## Context law
Only task-relevant context is loaded. Broad repository scans are a fallback, not the default.
