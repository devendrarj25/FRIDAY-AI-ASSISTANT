# Interoperability Patterns

## MCP
Use for tools/resources exposed to an agent. Normalize discovery and execution into FRIDAY's Tool Adapter.

## A2A
Use for agent-to-agent delegation and remote agent collaboration. Normalize tasks, artifacts, status and auth into FRIDAY's Agent Adapter.

## Extensions/plugins/skills
Treat them as packages that can contribute:
- tools
- skills
- agents
- workflows
- UI panels
- policies
- hooks
- schemas
- tests

## Rule
Interop is an ingress/egress layer. FRIDAY remains the authority plane.
