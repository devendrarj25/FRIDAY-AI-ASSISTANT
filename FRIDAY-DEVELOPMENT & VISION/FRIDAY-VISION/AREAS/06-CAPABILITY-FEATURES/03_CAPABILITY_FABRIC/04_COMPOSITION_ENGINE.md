# Composition Engine

Supported strategies:
- direct
- sequential chain
- parallel fan-out/fan-in
- DAG
- planner/executor/verifier
- primary/critic
- candidate/judge
- specialist panel
- observe/act/verify
- human-in-the-loop
- background task
- scheduled task
- event-triggered task
- remote delegation
- device handoff
- model escalation
- fallback chain
- speculative execution

Each node has:
`inputs, outputs, timeout, retry, idempotency, compensation, policy, verifier`.
