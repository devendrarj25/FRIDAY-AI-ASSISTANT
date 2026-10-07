# Systems Matrix — What FRIDAY Should Learn

| System | Strongest patterns | FRIDAY takeaway |
|---|---|---|
| OpenClaw | local gateway/control plane, channels, nodes, tools, skills, plugins, model/provider swap | Build one trusted local control plane; make every surface a client |
| Hermes Agent | 40+ tools, progressive skills, persistent memory, messaging gateway, browser backends, profiles | Separate toolsets from skills; load knowledge on demand; support many surfaces |
| AIOS | kernel abstraction for LLM/memory/storage/tools, scheduling/context switching | Treat AI resources like OS resources |
| UFO² | HostAgent + AppAgents, UIA/Win32/WinCOM, hybrid GUI/API, knowledge substrate | Prefer native OS APIs; use GUI as fallback |
| UFO³ | task DAGs, device pool, async orchestration, cross-device agent communication | Add a device/capability graph and dynamic DAG execution |
| OS-Copilot | OS-level generalist agent, web/code/files/multimedia/apps, self-improvement | One agent should span OS domains |
| Letta | stateful agents, persistent memory, identity, portable agents | Long-lived identity and memory are runtime primitives |
| LangGraph | durable execution, checkpoints, persistence, HITL | Task state must outlive a UI session |
| Deep Agents | filesystem context, subagents, skills, shell, HITL | Context engineering and isolated subagents belong in the harness |
| AutoGPT | visual builder, continuous agents, schedules/triggers, deployment | Features need lifecycle and trigger surfaces |
| Microsoft Agent Framework | graph workflows, sequential/concurrent/handoff/group collaboration, A2A/MCP | Standardize orchestration patterns |
| CrewAI | role-based crews, flows, collaboration | Feature composition can use specialist teams |
| VoltAgent | memory, RAG, guardrails, tools, MCP, voice, workflow, observability/evals | Capability fabric needs operations and evals |
| PydanticAI | typed agents/tools, realtime voice, structured outputs | Strong contracts reduce runtime ambiguity |
| AnythingLLM | dynamic model routing, memory, scheduled tasks, skill selection, MCP, multimodal | Make capabilities discoverable and schedulable |
| LibreChat | agents, MCP, skills, subagents, code workspaces, multi-provider | User-facing agent marketplace + workspace integration |
| Flowise | visual builder, agents, RAG, evaluations, HITL, API/SDK | Expose composed features as inspectable graphs |
| Langflow | visual workflows, MCP server, multi-agent orchestration, observability | Any feature can become a callable tool/service |
| n8n | 1500+ integrations, AI workflows, human approvals, observability | Integrations are a capability multiplier |
| Composio | 1000+ toolkits, auth, triggers, tool search, sandbox | Tool discovery and auth should be separate layers |
| Browser Use | browser actions, extraction, forms, long-running browser tasks | Browser is a first-class execution substrate |
| Stagehand | code + AI actions, self-healing, caching, observability | Prefer deterministic actions; use AI only where uncertainty exists |
| Playwright MCP | accessibility snapshots, structured browser control | Use structured page state before vision when possible |
| Agent S | GUI agent, learned experiences, multimodal grounding | Computer-use loop needs experience/evidence memory |
| UI-TARS | VLM GUI control, screenshot grounding, local/remote computer | Keep a pluggable visual grounding layer |
| OpenAdapt | demonstrations, training, evaluation, desktop/web automation | Learning from demonstrations can feed capability evidence |
| MagenticLite | small-model orchestration, browser/files, human steering, VM sandbox | Optimize for local/small models and safe takeover |
| OpenHands | sandboxed software agent runtime | Isolate powerful execution environments |
| SWE-agent | issue→repo→patch loop | Build domain-specific executor/verifier packs |
| Aider | repo map + edit/test loop | Codebase indexing is a capability, not just context |
| Goose | install/execute/edit/test, MCP/extensions | Local agent should be extensible without forking |
| OpenAI Codex | parallel agents, worktrees, skills, automations, long-running tasks | Parallel workspaces + async agent control are core UX |
| Claude Code | subagents, hooks, background tasks, checkpoints | Lifecycle hooks + rollback checkpoints are essential |
| Gemini CLI | extensions, skills, MCP, hooks, checkpoints, model routing | Extension manifests should carry tools/skills/policy/hooks |
| MarkItDown | broad document conversion with structure preservation | Normalize artifacts into a common internal representation |
| Mem0 | persistent memory layer | Memory should be a service boundary, not embedded in one agent |
