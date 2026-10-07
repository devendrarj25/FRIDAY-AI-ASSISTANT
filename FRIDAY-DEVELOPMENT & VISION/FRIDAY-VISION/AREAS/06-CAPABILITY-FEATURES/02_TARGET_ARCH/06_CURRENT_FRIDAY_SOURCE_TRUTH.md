# CURRENT FRIDAY SOURCE TRUTH

This package is based on inspection of the FRIDAY-main project discussed in this work.

## Existing runtime surfaces
Electron:
- electron/capabilities.cjs
- electron/capability-verify.cjs
- electron/tools.cjs
- electron/skills.cjs
- electron/agents.cjs
- electron/mcp-client.cjs

Renderer/core:
- src/lib/friday/capability-trees.ts
- src/lib/friday/brain/orchestrator.ts
- src/lib/friday/brain/core-brain.ts
- src/lib/friday/browser-engine.ts
- src/lib/friday/self/task-graph.ts
- core/registry.ts

Python kernel:
- kernel/tools.py
- kernel/planner.py
- kernel/memory.py

## Current shape
The project already contains broad capability inventories across skills, tools, agents,
plugins, workflows, modules, connectors and kernel tools. The problem is not "lack of
raw primitives"; it is fragmentation and inconsistent decision/execution contracts.

## Migration principle
Keep the current files working. Add adapters and a canonical facade. Route new features
through the facade. Move existing paths one family at a time. Delete duplicates only
after telemetry proves parity.
