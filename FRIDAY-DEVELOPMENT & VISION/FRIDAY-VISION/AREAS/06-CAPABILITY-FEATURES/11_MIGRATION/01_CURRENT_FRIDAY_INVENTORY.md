# Current FRIDAY Inventory

Based on the supplied FRIDAY source snapshot and prior architecture work:
- Electron 43 + React 19 + Vite + TypeScript
- Python FastAPI-style kernel
- Skills: 214
- Tools: 177
- Agents: 98
- Plugins: 78
- Workflows: 116
- Modules: 76
- Connectors: 113
- Kernel tools: 27

Important existing components:
- `electron/capabilities.cjs`
- `electron/capability-verify.cjs`
- `electron/tools.cjs`
- `electron/skills.cjs`
- `electron/agents.cjs`
- `electron/mcp-client.cjs`
- `electron/model-router.cjs`
- `electron/provider-registry.cjs`
- `electron/model-capabilities.cjs`
- `electron/tools.cjs`
- `electron/tool-authority.cjs`
- `electron/sandbox.cjs`
- `electron/sandbox-lab.cjs`
- `electron/readiness.cjs`
- `electron/service-health.cjs`
- `core/registry.ts`
- `core/discovery.ts`
- `kernel/planner.py`
- `kernel/authority.py`
- `kernel/memory.py`
- `kernel/tools.py`
- `kernel/runtimes.py`
- `src/lib/friday/brain/orchestrator.ts`
- `src/lib/friday/brain/core-brain.ts`
- `src/lib/friday/capability-trees.ts`

The goal is consolidation, not duplication.
