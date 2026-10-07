# EXTENSION CONFORMANCE

For every external pack:
manifest validation → signature/provenance → dependency audit → permission diff →
sandbox execution → capability tests → policy denial tests → upgrade test → quarantine test.

A protocol adapter must also prove that:
- unsupported protocol features fail closed
- timeouts are bounded
- malformed messages are rejected
- auth scopes are enforced
- artifacts are normalized
- events are emitted
