# State + Event Model

Every improvement-related operation emits an immutable event envelope.

Required fields:
- eventId
- timestamp
- session/task/goal id
- actor (`user`, `friday`, `system`, `evaluator`)
- artifact id/version
- model/provider used
- input sensitivity class
- action
- result
- verifier evidence
- confidence
- cost/latency/resource use
- parent event / lineage

Never use mutable status as the only source of truth. Status is a projection over events.

## Candidate lifecycle
`draft → sandboxed → evaluated → shortlisted → approved → canary → promoted → monitored → retired`

Failure states:
`rejected | invalid | regression | rolled-back | quarantined`
