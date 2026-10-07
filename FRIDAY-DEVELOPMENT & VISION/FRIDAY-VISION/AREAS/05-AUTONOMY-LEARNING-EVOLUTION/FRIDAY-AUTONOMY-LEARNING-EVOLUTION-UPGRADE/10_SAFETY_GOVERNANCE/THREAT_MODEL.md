# Threat Model

## Threats
- reward hacking / evaluator gaming
- benchmark contamination
- self-confirming memory
- prompt injection in research sources
- malicious dependency/tool generation
- credential leakage into training data
- infinite background loops
- runaway compute/cost
- silent policy weakening
- candidate/evaluator coupling
- model collusion in multi-agent evaluation
- stale external knowledge

## Controls
- provenance + source trust
- held-out evals
- evaluator immutability
- least-privilege tools
- sandboxed execution
- resource budgets
- independent verifier models
- deterministic tests
- canary + rollback
- audit log
- human approval for protected classes
