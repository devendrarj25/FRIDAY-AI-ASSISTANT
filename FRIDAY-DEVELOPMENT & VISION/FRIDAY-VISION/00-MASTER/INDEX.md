# FRIDAY VISION — MASTER INDEX

This workspace connects the detailed plans for the whole FRIDAY AI-OS project.

## Landed
- Brain / cognition — implemented in `src/lib/friday/brain/` (`cognitive-runtime.ts`, `cognitive-mind.ts`, `cognitive-control.ts`, and the existing brain owners). The `AREAS/02-BRAIN` plan was removed after that landing.
- Memory / knowledge / personalization — implemented in `src/lib/friday/brain/memory-fabric.ts` together with `memory-engine.ts`, `knowledge-base.ts`, `knowledge-ingest.ts`, `memory-policy.ts`, and `retrieval.ts`. The `AREAS/03-MEMORY-KNOWLEDGE-PERSONALIZATION` plan was removed after that landing.

## Areas
1. `01-SYSTEM` — system/core architecture
2. `04-MODELS-ROUTING` — providers/models/routing
3. `05-AUTONOMY-LEARNING-EVOLUTION` — autonomy/learning/evolution
4. `06-CAPABILITY-FEATURES` — capabilities, agents, skills, tools, plugins, workflows
5. `07-INTERACTION` — chat/voice/mobile/manual/automatic interaction
6. `08-PACKAGING-BUILD-UPDATE` — packaging/build/install/update/recovery

## Cross-area dependency direction

`System → Brain → Memory/Models/Capabilities → Interaction → Packaging`

This is a conceptual dependency direction. Real changes must follow the exact source/import graph.

## AI entry point

Start with:
1. `00-MASTER/00_READ_FIRST.md`
2. `00-MASTER/02_MASTER_CONTRACTS.md`
3. `00-MASTER/03_AI_CONTEXT_ROUTER.md`
4. `00-MASTER/04_AI_UPGRADE_PROTOCOL.md`
5. the relevant area plan
6. `FILE-ROUTING-MAP.md`
7. direct source owners and tests

## Key product decisions
- Public version: `Extreme.Major.Minor.Patch`
- REBUILD keeps the same public version.
- UPDATE changes the public version.
- Official application payload is replaceable.
- User-owned components/data are preserved across official updates.
- Heavy/optional resources are Install Manager resources.
- Required normal-size dependencies are deterministic build/bootstrap dependencies.
- CMD and GitHub use the same release/build contract.
- FRIDAY-managed resources live under the FRIDAY-managed root where practical.
- Uninstall supports Keep Data and Remove All FRIDAY Data.
- All lifecycle operations are transactional and recoverable.
