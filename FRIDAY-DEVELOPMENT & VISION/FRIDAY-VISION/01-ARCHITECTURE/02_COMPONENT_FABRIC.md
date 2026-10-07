# Component Fabric

All extensible FRIDAY capabilities use one component model.

## Types
`agent | skill | tool | plugin | workflow | connector | model | runtime | package`

## Component manifest
```json
{
  "schema": 1,
  "id": "com.example.friday.component",
  "type": "agent",
  "version": "1.2.3",
  "owner": "user",
  "source": "manual-upload",
  "entrypoint": "...",
  "compatibility": {"friday": ">=1.2.0"},
  "dependencies": [],
  "permissions": [],
  "files": [],
  "contentHash": "sha256:..."
}
```

## Critical rule
Official and user components may have similar display names but must never share identity.

## Resolution
When multiple versions exist, resolve by:
1. explicit task requirement
2. compatibility
3. trust/owner policy
4. version
5. health
6. deterministic tie-breaker
