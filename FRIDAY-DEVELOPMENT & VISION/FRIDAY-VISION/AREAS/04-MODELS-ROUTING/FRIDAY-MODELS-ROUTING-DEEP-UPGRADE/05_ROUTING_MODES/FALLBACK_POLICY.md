# Fallback policy

Error classes, retry, backoff, fallback order, and the circuit breaker now live on the router. What remains is escalation after a model has already answered badly.

## Escalation-worthy

- model refusal when another allowed model can complete safely
- tool-call failure
- schema failure
- low-confidence verification
- context overflow after compaction
