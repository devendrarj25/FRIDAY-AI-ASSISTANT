# Build / Install / Release Protection

This interaction upgrade is runtime architecture. Do not change packaging, installer, release workflows, CI/CD or build configuration unless inspection proves a runtime dependency cannot be integrated otherwise.

If a voice runtime artifact needs installation support, extend the existing Install Manager/catalog/health path. If a remote companion needs packaging, integrate with existing companion/runtime distribution. Do not create a second installer or release pipeline.

Any necessary build-system change requires real build/install evidence before the change can be considered complete.
