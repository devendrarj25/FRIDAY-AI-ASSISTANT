# Target AI-OS Architecture

```text
┌────────────────────────────────────────────────────────────────────┐
│                         FRIDAY EXPERIENCE                           │
│ Chat • Voice • Desktop • Browser • Mobile/Remote • Automation UI   │
└───────────────────────────────┬────────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────────┐
│                         FRIDAY ORCHESTRATOR                         │
│ intent → context → plan → authorize → execute → verify → learn    │
└───────┬──────────────┬──────────────┬──────────────┬──────────────┘
        │              │              │              │
        ▼              ▼              ▼              ▼
  Brain/Reasoning   Memory Fabric   Capability    Model/Provider
                                  Fabric           Router
        │              │              │              │
        └──────────────┴──────┬───────┴──────────────┘
                              ▼
                    Authority / Policy Plane
                              │
                              ▼
             Runtime + Component + Tool Registry
                              │
                              ▼
               Sandbox / OS / Browser / Files
                              │
                              ▼
                     Verification / Evidence
                              │
                              ▼
                Experience + Learning + Memory
                              │
                              └──────► next task
```

## Principle
The layers are services/contracts, not necessarily separate processes. Keep boundaries explicit while avoiding unnecessary IPC and latency.

## Control loop
`Observe → Understand → Retrieve → Plan → Authorize → Execute → Verify → Record → Learn`

Every autonomous action should be traceable through this loop.
