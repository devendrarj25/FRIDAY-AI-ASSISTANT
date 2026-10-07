# Canonical Contract Registry

`10_CONTRACTS/` is the single canonical contract location for implementation. Existing contracts remain authoritative where they already cover a concept; the new v2 contracts add only missing cross-surface/mobile runtime boundaries.

| Contract | Purpose |
|---|---|
| 13_interaction-surface | identifies the active experience surface and negotiated versions |
| 14_capability-advertisement | runtime capability/renderer/permission availability |
| 15_permission-evidence | browser/device permission state evidence |
| 16_connection-session | authenticated mobile remote session lifecycle |
| 17_sync-cursor | snapshot/event/capability synchronization |
| 18_media-session | mobile browser media lifecycle |

`15_INTEGRATED_SOURCE_CONTRACTS/` contains preserved source-package contract copies for traceability only. Implementation must not create a second runtime registry from them.