# READ FIRST

## What this package fixes
FRIDAY already has a large capability inventory. The architectural risk is fragmentation: separate registries and runtimes can each know about skills, tools, agents, workflows, modules, plugins, connectors and models without a single capability-aware execution brain.

The upgrade therefore introduces a **Capability Fabric** and a **Feature Control Plane** above the existing runtime.

## Target mental model
- Capability = what FRIDAY can do.
- Feature = a user-facing outcome composed from one or more capabilities.
- Tool = executable primitive.
- Skill = procedural knowledge.
- Agent = reasoning/execution unit.
- Workflow = explicit execution graph.
- Connector = authenticated external boundary.
- Module = long-lived subsystem.
- Model = intelligence resource.
- Provider = model/service transport.
- Policy = what is allowed.
- Evidence = why FRIDAY believes a capability works.
- Readiness = whether it can be used now.
- Verification = whether the outcome was actually achieved.

## Runtime
`Intent → Context → Capability Broker → Feature Composer → Policy Gate → Executor → Event Stream → Verifier → Memory/Learning`

## Important
Do not replace `electron/capabilities.cjs`, `electron/tools.cjs`, `electron/skills.cjs`, `electron/agents.cjs`, `electron/mcp-client.cjs`, or `core/registry.ts` blindly. Wrap and migrate them behind the new contracts.
