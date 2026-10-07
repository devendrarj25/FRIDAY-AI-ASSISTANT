# TARGET COMPONENT MAP

## New canonical layer
core/capabilities/
- contract.ts
- registry.ts
- normalizer.ts
- broker.ts
- composer.ts
- readiness.ts
- health.ts
- evidence.ts
- cache.ts
- adapters/

core/features/
- contract.ts
- registry.ts
- resolver.ts
- composer.ts
- packs.ts

core/execution/
- task-contract.ts
- runtime.ts
- scheduler.ts
- checkpoint.ts
- leases.ts
- retries.ts
- idempotency.ts
- cancellation.ts
- event-stream.ts

core/trust/
- policy.ts
- authority.ts
- secrets.ts
- sandbox.ts
- quarantine.ts

core/artifacts/
- contract.ts
- registry.ts
- provenance.ts
- sensitivity.ts

core/interop/
- protocol.ts
- mcp.ts
- a2a.ts
- plugins.ts
- connectors.ts
- device.ts

## Electron integration
electron/capability-fabric.cjs
electron/feature-fabric.cjs
electron/execution-bridge.cjs
electron/device-gateway.cjs
electron/interop-gateway.cjs

## Python kernel integration
kernel/capability_bridge.py
kernel/durable_runtime.py
kernel/evidence.py

Do not create a second parallel "brain". These are control-plane services used by the
existing brain/orchestrator.
