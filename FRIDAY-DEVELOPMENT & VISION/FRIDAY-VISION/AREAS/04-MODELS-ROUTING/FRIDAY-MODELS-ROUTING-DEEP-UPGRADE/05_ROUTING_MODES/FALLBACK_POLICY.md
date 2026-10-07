# Fallback policy

## Error classes

### Retryable
- timeout
- connection reset
- 429/rate limit
- 502/503/504
- transient provider unavailable

### Not retryable on same candidate
- invalid API key
- invalid model ID
- unsupported parameter
- malformed request
- capability mismatch
- policy/privacy mismatch
- retired model

### Escalation-worthy
- model refusal when another allowed model can complete safely
- tool-call failure
- schema failure
- low-confidence verification
- context overflow after compaction

## Fallback ordering

1. Same model, different healthy endpoint.
2. Same provider, compatible sibling model.
3. Different provider, same model family/capability.
4. Different model optimized for the task.
5. Multi-model rescue if allowed.

Avoid immediate fallback to a correlated endpoint that shares the same outage domain.

## Backoff

Use provider-provided `Retry-After` when available. Otherwise exponential backoff with jitter and a provider/model cooldown state.

## Circuit breaker

Track:

- consecutive failures
- rolling failure rate
- failure class
- cooldown until
- last success
- recovery probe result

Do not quarantine a provider for a single deterministic 400.
