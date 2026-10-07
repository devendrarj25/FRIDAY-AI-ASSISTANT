# Capability Contract

A capability must declare:

```json
{
  "id": "cap.browser.navigate",
  "version": "2.0.0",
  "kind": "capability",
  "intentTags": ["browse", "navigate", "web"],
  "inputs": [{"name":"url","type":"uri","required":true}],
  "outputs": [{"name":"page","type":"artifact.page"}],
  "requires": {"os":["windows"],"network":true},
  "permissions": ["network.read"],
  "risk": "low",
  "supports": {
    "streaming": true,
    "cancellation": true,
    "resume": true,
    "dryRun": true
  },
  "evidence": {"verificationLevel":"L4"},
  "health": {"status":"healthy"},
  "readiness": {"ready":true},
  "cost": {"unit":"call","estimated":0.0}
}
```

## Contract rules
- backward-compatible input/output evolution
- explicit errors
- deterministic IDs
- no hidden side effects
- side effects classified
- artifacts typed
- permissions explicit
- test/verification hooks declared
