# Adapters

Adapters normalize external/internal resources into the capability contract.

Required adapter families:
- legacy FRIDAY tool
- legacy FRIDAY skill
- legacy FRIDAY agent
- legacy workflow
- plugin
- connector
- MCP server/tool
- A2A agent
- browser backend
- desktop backend
- device node
- model/provider
- remote worker
- future protocol

Adapter responsibilities:
discover → normalize → health probe → invoke → map result → telemetry → verify.
