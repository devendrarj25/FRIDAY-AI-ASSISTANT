# Coding-agent master implementation prompt

You are upgrading the existing FRIDAY repository. Do not rebuild it from scratch.

## Mission
Implement the Capability & Feature Ultimate Fabric described in this package.

## Rules
1. Inspect existing code before editing.
2. Preserve current functionality and routes.
3. Prefer adapters over rewrites.
4. Create canonical contracts first.
5. Add tests before cutting over behavior.
6. Run legacy and new paths in shadow mode before switching.
7. Keep provider/model routing separate from capability selection.
8. Keep policy/authority outside individual tools.
9. Never expose secrets to model context.
10. Never treat tool success as outcome verification.
11. Do not expose hidden chain-of-thought in UI/logs.
12. Add feature flags and rollback for every migration stage.

## Required deliverables
- capability contracts
- canonical registry
- legacy adapters
- broker
- composer
- durable task runtime
- event stream
- feature registry/runtime
- health/readiness/evidence
- computer-use adapters
- MCP/A2A/plugin adapters
- UI capability center
- live task center
- evaluation suite
- migration telemetry
- docs

## Required verification
- TypeScript checks
- Python checks
- unit tests
- integration tests
- capability discovery parity
- task resume test
- policy enforcement test
- browser/desktop smoke tests
- plugin quarantine test
- MCP/A2A conformance tests
- build + package + readiness tests

## Cutover
Do not remove old code until:
- parity ≥ 99% for discovery
- no critical policy regressions
- long-running task recovery passes
- high-priority feature suites pass
- rollback path is tested
