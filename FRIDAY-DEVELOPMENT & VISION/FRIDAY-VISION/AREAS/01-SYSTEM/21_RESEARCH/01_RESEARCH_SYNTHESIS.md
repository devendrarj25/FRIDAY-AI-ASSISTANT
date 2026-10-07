# Deep External Research Synthesis — September 2026

The target architecture was cross-checked against current public/open-source agent systems and infrastructure. The purpose is not to import a framework into FRIDAY; it is to extract proven architectural patterns and keep FRIDAY's existing source of truth.

## OpenHands
OpenHands currently separates its frontend control center from the Agent Server, SDK, tools, conversations, workspaces and event system. Its agent architecture emphasizes a stateless/event-driven reasoning-action loop, context management and security validation. Its SDK supports local or ephemeral Docker/Kubernetes workspaces. FRIDAY should adopt the **separation of presentation, agent runtime, workspace isolation and event history**, while keeping FRIDAY's Electron/kernel architecture. citeturn0search2turn0search7turn0search10

## Letta / MemGPT lineage
Letta's current architecture emphasizes persistent identity, experience across conversations, editable memory blocks, long-term memory and agents that can adapt their memory/skills/harness. FRIDAY should adopt the **persistent identity + experience + memory hierarchy** idea, but learned memory must remain below immutable owner policy. citeturn0search0turn0search6turn0search11

## Open Interpreter
Open Interpreter demonstrates a practical computer-oriented loop: models can run code, operate browsers/desktops and create/edit media, with approval before execution. Its current project also describes native sandboxing, model switching and computer-use QA. FRIDAY should adopt the **computer-use capability model and explicit approval boundary**, but route all privileged actions through FRIDAY's existing authority broker. citeturn1search1turn1search8turn1search9

## Microsoft Agent Framework
Microsoft's current Agent Framework is the successor direction to AutoGen and provides layered agent APIs, multi-provider orchestration, MCP and A2A integration. The research lesson is **layering and protocol interoperability**, not replacing FRIDAY with another framework. AutoGen itself is now maintenance mode. citeturn0search4turn1search5turn1search17

## LangGraph
LangGraph's persistence model separates thread checkpoints from long-term stores and supports durable execution and human-in-the-loop interruption. FRIDAY should adopt the **checkpoint-before-side-effect and resume-from-state** discipline. citeturn0search12turn0search18

## E2B / sandbox infrastructure
E2B demonstrates isolated environments where agents can run commands, install dependencies, access files and network resources, and provides desktop-oriented sandboxing. FRIDAY should apply the **ephemeral isolated workspace** pattern to self-development and risky code execution, adapted to Windows and the existing local sandbox. citeturn1search4turn1search12

## OpenTelemetry GenAI
OpenTelemetry now has GenAI semantic conventions covering model, agent, event, metric and exception signals. FRIDAY should propagate trace context through model calls, agent work, tools and external connectors using stable semantic fields. citeturn0search9turn0search13

## Browser automation
Open-browser-use demonstrates a capability-gated broker architecture in which the agent interacts with an MCP surface while a per-session broker drives the actual browser. FRIDAY should use the same **brokered browser control** principle rather than giving models direct browser-debug privileges. citeturn0search20

## Protocols
MCP is the tool/resource interoperability boundary; A2A is the remote-agent interoperability boundary. FRIDAY should keep these as adapters at the capability fabric edge, never as authorities over policy.
