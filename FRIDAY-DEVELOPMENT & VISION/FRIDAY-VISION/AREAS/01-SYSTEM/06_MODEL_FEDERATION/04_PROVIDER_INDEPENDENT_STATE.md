# Provider-Independent State

Never store essential FRIDAY identity, task state, approvals, memory or capability definitions only inside provider-specific conversation state.

Persist canonical FRIDAY envelopes locally. Provider adapters translate into provider-native formats and back. This permits:
- local ↔ cloud failover;
- model migration;
- provider outages;
- context compaction;
- long-running tasks beyond a single model session;
- deterministic recovery after restart.
