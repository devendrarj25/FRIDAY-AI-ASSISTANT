# FRIDAY VISION — Area Dependency Map

```text
SYSTEM / CORE
 ├─ BRAIN / ORCHESTRATION
 │   ├─ MEMORY / KNOWLEDGE / PERSONALIZATION
 │   ├─ MODELS / PROVIDERS / ROUTING
 │   └─ AUTONOMY / LEARNING / EVOLUTION
 ├─ CAPABILITIES / FEATURES
 │   └─ Agents / Skills / Tools / Plugins / Workflows
 ├─ INTERACTION
 │   └─ surfaces over the shared brain/capability contracts
 └─ PACKAGING / BUILD / UPDATE
     └─ packages the validated application + preserves user state/components
```

## Rules
- System/Core owns shared contracts.
- Brain consumes memory, model-routing and capability contracts.
- Memory/Knowledge is persistent state and must not be treated as replaceable application payload.
- Models/Routing provides model/provider selection, capability and health information.
- Capabilities use common identity, ownership, compatibility and authority semantics.
- Interaction is a surface; it must not become a second brain or registry.
- Packaging/Build/Update consumes validated outputs and preserves user-owned components/data.
- Cross-area changes must inspect every affected contract and its tests.
