# Research Catalog — 2026 Expanded

External projects are evidence, not dependencies. Claims below describe observed architecture/features and are not treated as independently verified production guarantees.

| Source | Useful pattern | FRIDAY decision |
|---|---|---|
| aiOS | AI-first desktop daemon, local-first inference, global overlay, cloud fallback | adopt pattern; keep Windows FRIDAY architecture |
| tgifriday-ai-os | native OS remains native, AI intervenes when useful, backend switching | adopt |
| Zoey OS | voice/text continuity, persistent memory, visible delegation, companions, activity stream | adapt; do not copy UI |
| Personal AI OS | kernel/shell/drivers/scheduler/storage mental model, 24/7 tasks | adapt |
| Personal-AI-OS | knowledge graph, cognitive model, multimodal specialized agents | adapt |
| personal-ai-os | provider-neutral persistent state, auditable execution, isolated plugins | adopt |
| Eidetic OS | local-first memory, hybrid RAG, scheduled reports, self-updating skills | adapt |
| RAG-OS | durable state outside model context, small kernel | adopt |
| xopc | local desktop assistant, projects/tasks, memory and skills | adapt |
| JARVIS | DAG agents, persistent graph, adaptive routing, telemetry | adapt |
| Jarvis OS | mobile command center, background jobs, approvals, provider routing | adapt |
| Jarvis OS Agent | Windows control, remote Android/Telegram, proactive listeners, vision/OCR | adapt with stronger governance |
| JARVIS-AI-OS | one brain/many shells, persistent memory, cross-surface sync | adopt principle |
| OpenJarvis | local-first wake→ASR→event bus→LLM, MCP tools | adapt |
| IRIS | realtime voice brain + long-running work brain, live tool events, approvals | adapt without split-brain state |
| IRIS-AI | voice, vision, automation, LangGraph-style state, security boundaries | adapt |
| OpenHands | event-driven agent loop, workspace isolation, context management | adopt patterns |
| Letta | persistent agent identity/memory/experience | adapt |
| Open Interpreter | computer use, MCP, shell, model switching | adapt |
| Microsoft Agent Framework | layered multi-agent, MCP/A2A | adapt |
| LangGraph | checkpoints, long-term stores, HITL, time travel | adopt concepts |
| Temporal | durable workflows and replay | adapt principles; avoid unnecessary dependency |
| E2B | isolated code/desktop sandboxes | adapt isolation model |
| OpenTelemetry GenAI | agent/model spans and metrics | adopt telemetry semantics |
| A2A | agent discovery, tasks, artifacts, streaming | adapt protocol boundary |
| MCP | tool/resource protocol and authorization boundaries | adapt protocol boundary |
| Tailscale | private overlay remote networking | adopt architectural pattern |
| webcmd | browser workflow memory and fallback learning | adopt pattern |
| agent-computer-use | accessibility-first deterministic computer control | adopt |
| computer-use MCP | accessibility tree, secure fields, user-active yielding | adopt |
| screen-use | UIA-first + vision fallback + introspection/meta-learning | strongly adopt |
| Cua | browser + native desktop in one control session | adapt |
| UI-TARS desktop | vision GUI agent, terminal/browser/MCP | adapt as optional vision tier |
| open-computer-use | sandboxed live desktop streaming, pause, model swap | adapt |
| Browser Use Desktop | desktop browser agent sessions and remote inbound channels | adapt |
| Windows-Use | Windows UIA control, virtual desktops, persistent memory | adapt |
| whisper-loop | local streaming STT/LLM/TTS and instant barge-in | adopt voice loop principles |
| self-improving-agent | metrics, prompt versioning, rollback, guarded tools | adopt |
| self-improving-agent-harness | outer-loop candidate evaluation and regression discard | adopt |
| agent-runtime | event-sourced journal, deterministic replay, approvals, ambiguous effect recovery | strongly adopt |
| CORE | always-on tasks, temporal knowledge graph, dedicated task threads | adapt |
| PersonalOS | router → domain copilots → skills → learnings | adapt |
| Current security lessons | cross-agent channels, prompt injection and sandbox boundary failures remain real risks | strengthen zero-trust design |
