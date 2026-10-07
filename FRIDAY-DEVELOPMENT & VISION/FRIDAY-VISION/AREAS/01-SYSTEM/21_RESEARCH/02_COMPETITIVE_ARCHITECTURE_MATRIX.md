# Competitive Architecture Matrix

| System | Strong pattern to learn | FRIDAY adaptation |
|---|---|---|
| OpenHands | Event-driven agent loop + isolated runtime + separate frontend/backend | Shared task/event fabric over Electron/kernel |
| Letta | Persistent identity + memory hierarchy + long-lived experience | FRIDAY memory OS with immutable policy above it |
| Open Interpreter | Computer control + code execution + approval | Existing FRIDAY authority broker + sandbox |
| Microsoft Agent Framework | Layering + MCP/A2A + multi-agent orchestration | Protocol adapters in capability fabric |
| LangGraph | Checkpointing + durable execution + HITL | Task graph/ledger with side-effect-safe resume |
| E2B | Ephemeral sandboxed execution | Local Windows sandbox/isolated workspaces |
| Browser-use/open-browser-use | Brokered browser control | Browser capability through FRIDAY authority |
| OpenTelemetry | Standard trace/metric/event semantics | Unified trace IDs across Electron/kernel/agents |

No external system should be copied wholesale. FRIDAY already has a substantial desktop, kernel, capability and governance base; the correct move is to harden its contracts and interconnect its existing owners.
