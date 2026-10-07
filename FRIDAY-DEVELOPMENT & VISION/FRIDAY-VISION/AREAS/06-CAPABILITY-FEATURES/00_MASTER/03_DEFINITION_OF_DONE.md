# Definition of Done

FRIDAY's Capability & Feature Fabric is complete when:

### Registry
- All existing skills/tools/agents/workflows/modules/plugins/connectors/models are discoverable through a canonical normalized view.
- Every entry has stable ID, version, owner, lifecycle, capabilities, requirements, permissions, health, readiness and evidence.

### Broker
- Intent is mapped to capability requirements.
- Hard policy/resource filters run before scoring.
- Broker can explain selection and rejection.
- Broker supports direct, chain, parallel, delegation, escalation and verification patterns.

### Runtime
- Tasks stream progress and partial artifacts.
- Tasks can pause/resume/cancel/retry.
- Task state survives renderer restart.
- Long jobs use checkpoints and leases.
- Duplicate execution is prevented with idempotency keys.

### Computer use
- Browser and desktop actions use observe→plan→act→observe→verify.
- Native APIs are preferred over fragile GUI actions where possible.
- Risky actions require approval according to policy.
- Sandboxed execution is available for untrusted work.

### Quality
- Health/readiness/correctness are separate.
- L0–L5 verification evidence is stored.
- Capability regression tests run automatically.
- External components are quarantined on repeated failures or policy violations.

### UX
- One global "What can you do?" capability explorer.
- Feature cards show prerequisites, risk, privacy, estimated cost/time and current readiness.
- Running tasks show live state and controls.
- Users can inspect why a capability was selected.

### Future proof
- Protocol adapters are versioned.
- Schema evolution is backward-compatible.
- No core feature depends on one provider/model.
- New model/tool/protocol can be added through a manifest + adapter + tests.
