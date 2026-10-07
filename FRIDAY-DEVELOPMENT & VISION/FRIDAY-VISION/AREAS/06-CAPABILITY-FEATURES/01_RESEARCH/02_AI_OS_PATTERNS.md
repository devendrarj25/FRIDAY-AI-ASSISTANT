# AI-OS Patterns

## Pattern A — Kernel/resource abstraction
AIOS separates LLM, memory, storage and tools from agents. FRIDAY should similarly expose:
`ModelResource`, `MemoryResource`, `StorageResource`, `ToolResource`, `ComputeResource`, `BrowserResource`, `DeviceResource`.

## Pattern B — Trusted gateway
OpenClaw's gateway pattern suggests a local control plane that owns sessions, tools, events and channels. FRIDAY should make the Electron/kernel bridge the trusted local control plane, not allow individual plugins to invent their own authority.

## Pattern C — Application agents
UFO² shows the value of an OS-level coordinator plus per-application agents. FRIDAY should maintain `Host/Task Agent → App/Domain Executor → Native/GUI Action`.

## Pattern D — Cross-device constellation
UFO³ adds device pools, DAGs and async coordination. FRIDAY should treat each device as a capability node with declared resources and trust.

## Pattern E — Long-lived identity
Letta/Hermes emphasize persistent state, identity and procedural memory. FRIDAY's memory and skills should attach to user/project/device/task scopes.

## Pattern F — Capability marketplace
OpenClaw, Hermes, Gemini CLI and LibreChat demonstrate extension/skill/plugin ecosystems. FRIDAY should support signed/verified manifests, staged installation, compatibility checks, health probes and quarantine.

## Pattern G — Progressive disclosure
Large tool inventories should not all enter the model context. Broker retrieves compact capability cards first, then expands only selected schemas.
