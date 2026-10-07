# FRIDAY VISION — File Routing Map

Use this as the first-pass source locator. Open the smallest relevant owner set first.

| Area / task | Primary source owners |
|---|---|
| Core capabilities / authority | `electron/capabilities.cjs`, `electron/capability-verify.cjs`, `electron/tool-authority.cjs`, `core/registry.ts`, `core/discovery.ts` |
| Skills / Agents / Tools | `electron/skills.cjs`, `electron/agents.cjs`, `electron/tools.cjs` |
| Models / Providers / Routing | `electron/model-router.cjs`, `electron/provider-registry.cjs`, `electron/model-capabilities.cjs`, `electron/mcp-client.cjs` |
| Brain / orchestration | `src/lib/friday/brain/cognitive-runtime.ts`, `src/lib/friday/brain/cognitive-mind.ts`, `src/lib/friday/brain/cognitive-control.ts`, `src/lib/friday/brain/core-brain.ts`, `kernel/planner.py`, `kernel/authority.py` |
| Memory / Knowledge | `src/lib/friday/brain/memory-fabric.ts`, `context-engine.ts`, `knowledge-base.ts`, `knowledge-graph.ts`, `knowledge-ingest.ts`, `memory-policy.ts`, `retrieval.ts`, `vector-index.ts`, `src/lib/friday/self/memory-engine.ts`, `memory-consolidate.ts`, `memory-teach.ts`, `kernel/memory.py` |
| Autonomy / self-evolution | `src/lib/friday/self/task-graph.ts` plus the area-specific autonomy owners |
| Interaction | `src/lib/friday/browser-engine.ts` plus interaction routes/components |
| Packaging / Build | `package.json`, `electron-builder.yml`, `config/friday-version.json`, `config/toolchain-versions.json`, `scripts/build-windows.cmd`, `scripts/release-engine.cjs`, `scripts/electron-pack.cjs` |
| Update / Recovery | updater/installer/recovery owners + update manifest/schema files |
| Release verification | `scripts/verify-build.cjs`, `scripts/verify-boot.cjs`, `scripts/readiness-test.cjs`, `scripts/check-engines.cjs` |
