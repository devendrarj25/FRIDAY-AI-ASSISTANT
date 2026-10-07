# Capability Broker

## Two-stage selection

### Hard filters
Reject candidates for:
- policy
- missing permissions
- incompatible OS/device
- unavailable dependency
- unsupported input/output
- insufficient model modality
- resource budget
- stale/quarantined status

### Soft score
`score = 0.24*task_fit + 0.15*reliability + 0.12*evidence + 0.10*latency + 0.10*cost + 0.08*privacy + 0.08*locality + 0.06*success_history + 0.04*context_fit + 0.03*novelty`

Weights are configuration, not code constants.

## Explainability
Broker returns:
- selected candidate
- top alternatives
- hard rejections
- score breakdown
- evidence
- required permissions
- expected cost/time
- fallback plan
