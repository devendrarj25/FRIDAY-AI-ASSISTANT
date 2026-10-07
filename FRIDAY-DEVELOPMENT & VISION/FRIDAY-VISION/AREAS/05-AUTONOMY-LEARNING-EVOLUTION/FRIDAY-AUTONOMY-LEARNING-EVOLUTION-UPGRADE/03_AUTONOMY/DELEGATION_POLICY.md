# Delegation and Approval Policy

Safe automatic actions should be explicit, bounded and reversible.

## Auto-allowed candidates
- read-only diagnostics
- local benchmark execution
- memory consolidation under existing policy
- cache refresh
- non-destructive research
- candidate generation inside sandbox
- evaluation of candidates
- creation of reports

## Review-required
- installing a new tool/skill
- changing routing policy
- changing prompts that affect all tasks
- activating an adapter
- changing memory promotion rules
- changing workflow topology used by production

## Always-review / protected
- governance/security/privacy code
- credential handling
- external communication policy
- unrestricted network permissions
- deleting backups
- disabling rollback
- changing autonomy policy itself
- self-replication
- modifying the evaluator to make a failing candidate pass

A model may propose a change to these areas but cannot authorize it.
