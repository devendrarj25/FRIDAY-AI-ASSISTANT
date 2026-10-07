# FEATURE COVERAGE MATRIX

The machine-readable catalog contains the canonical target inventory. Each feature must
map to at least one capability graph and one success predicate.

Domains covered:
Communication, Research, Browser, Desktop, Coding, Documents, Data, Media, Automation,
Devices, Personal AI, Business, System, AI Runtime, Interop and Multimodal.

Implementation policy:
- build reusable primitives first
- compose user-facing features second
- never create a feature-specific one-off executor when an existing capability can serve it
- every new feature adds a golden test
