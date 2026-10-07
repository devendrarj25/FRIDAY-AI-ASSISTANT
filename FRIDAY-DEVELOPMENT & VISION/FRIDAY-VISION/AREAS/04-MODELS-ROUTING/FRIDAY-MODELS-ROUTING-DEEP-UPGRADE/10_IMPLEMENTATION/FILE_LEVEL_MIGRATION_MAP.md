# File-level migration map for the supplied FRIDAY project

## Keep and extend

| Current file | Target role |
|---|---|
| `electron/models.cjs` | legacy compatibility facade → Model Intelligence discovery service |
| `electron/providers.cjs` | runtime detection adapter |
| `electron/provider-registry.cjs` | canonical registry facade over new resource store |
| `electron/model-router.cjs` | policy router facade → new Route Planner |
| `electron/model-capabilities.cjs` | capability evidence resolver |
| `electron/model-access.cjs` | auth/entitlement/access policy helper |
| `electron/model-download.cjs` | local lifecycle adapter facade |
| `kernel/router.py` | transport/streaming compatibility backend |
| `core/ai/contracts.ts` | shared contract definitions |
| `core/ai/model-router/index.ts` | public core routing API |
| `core/ai/model-manager/index.ts` | model lifecycle API |
| `src/lib/friday/model-catalog.ts` | renderer catalogue client |
| `src/lib/friday/models-engine.ts` | renderer model orchestration facade |
| `src/lib/friday/model-routing-contract.ts` | route contract |
| `src/routes/models.tsx` | Models UI |
| `src/components/friday/settings/AISettings.tsx` | provider/settings UI |
| `config/models.yaml` | compatibility import only; no longer source of truth |

## New target directories (suggested)

```text
core/models/
  contracts/
  registry/
  catalog/
  evidence/
  lifecycle/
  routing/
  ensemble/
  health/
  performance/
  policy/
providers/
  manifests/
  adapters/
  runtimes/
```

## Important

Do not create `models-v2` beside the current model system and leave both active. Build the new layer behind interfaces, migrate callers, then retire duplicate logic.
