# SELECTION ALGORITHM

### Stage A — requirement extraction
Convert user intent into:
- goal
- required actions
- input artifact types
- output artifact types
- modality requirements
- platform/device constraints
- data boundary
- latency target
- cost budget
- risk ceiling
- verification predicate

### Stage B — hard filters
Reject if any:
policy, authority, data boundary, platform, modality, dependency, readiness,
quarantine, resource budget, version compatibility, or required output mismatch.

### Stage C — score
Weights are runtime configuration:
task_fit
evidence_quality
recent_success
reliability
verification_rate
latency
cost
privacy/locality
resource_fit
context_fit
user_preference

### Stage D — compose
Choose direct, chain, parallel, DAG, delegation, escalation or human gate.

### Stage E — verify
Require the capability's declared success predicate plus independent evidence where
side effects matter.

### Stage F — learn
Record only verified outcome and environment conditions.

Never optimize solely for model confidence.
