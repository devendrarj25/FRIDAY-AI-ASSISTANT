# Failure Injection Matrix

| Fault | Expected result |
|---|---|
| Chat renderer reload | task continues; UI rehydrates |
| Voice TTS crash | task continues; text/visual fallback |
| ASR timeout | bounded provider fallback or clarification |
| Voice barge-in | old generation canceled/dropped |
| Mobile disconnect | task continues; reconnect from cursor |
| Duplicate remote command | idempotency prevents duplicate mutation |
| Approval expires | action remains blocked; fresh approval required |
| Tool timeout after submit | unknown + reconciliation |
| Model failure | route fallback if policy-compatible |
| Capability unavailable | bounded replan/fallback |
| Event gap | snapshot/cursor reconciliation |
| Resource pressure | throttle/degrade background work |
| Policy verification failure | privileged path fails closed |
| Prompt injection | untrusted content cannot grant authority |
