# FRIDAY — Brain Intelligence Research

_FRIDAY - AI ASSISTANT. A Private, Autonomous and Self Learning OS Based on Local & Cloud Models._

Research for the Brain evolution, written 2026-10-30. It answers one question: what do the best documented AI systems do that FRIDAY's Brain does not yet do, and which of it fits a local-first, single-owner Windows assistant. The decisions it supports are in [FRIDAY_ULTIMATE_BRAIN_ARCHITECTURE.md](FRIDAY_ULTIMATE_BRAIN_ARCHITECTURE.md), [FRIDAY_BRAIN_CAPABILITY_MATRIX.md](FRIDAY_BRAIN_CAPABILITY_MATRIX.md), [FRIDAY_BRAIN_GAP_ANALYSIS.md](FRIDAY_BRAIN_GAP_ANALYSIS.md) and [FRIDAY_BRAIN_IMPLEMENTATION_ROADMAP.md](FRIDAY_BRAIN_IMPLEMENTATION_ROADMAP.md).

## How to read this document

- **Access date** for every source below is 2026-10-30.
- **Read** means the page text itself was fetched in this session and the statements come from it. **Search only** means only a search-result summary was seen, so the statement is secondary and marked unverified. **Blocked** means the host could not be reached from this session.
- A vendor's own benchmark number is a claim, never a measurement of FRIDAY. Marketing is not evidence, and no number here is used to claim FRIDAY is smarter.
- Hosts blocked from this session: `openai.github.io`, `modelcontextprotocol.io`, `google.github.io`, `docs.langchain.com`, `arxiv.org`. To verify the rows marked "search only", allow those hosts in the session's network settings and the rows can be re-read.

## 1. Sources and what was learned

### 1.1 Agent frameworks and protocols

| System | What it is (as read) | What makes it effective | Limits and failure modes | Source, access |
| --- | --- | --- | --- | --- |
| OpenAI Agents SDK | Python SDK, MIT. Core: agents (LLM + instructions, tools, guardrails, handoffs), agents-as-tools and handoffs, tools (functions, MCP, hosted), guardrails (input and output checks), human in the loop, sessions (automatic history), tracing (built in), sandbox agents, realtime and voice agents. | One small set of primitives, tracing on by default, handoff versus agent-as-tool split. | Tied to its own model API by default; secondary notes say the "specialist owns the answer → handoff, manager owns it → tool" rule of thumb (search only). | [github.com/openai/openai-agents-python](https://github.com/openai/openai-agents-python) — **read** |
| Anthropic, "Building effective agents" | Engineering guide. Five workflow patterns (prompt chaining, routing, parallelization with sectioning or voting, orchestrator-workers, evaluator-optimizer), and agents as LLMs directing their own tool use. | Start simple; add complexity only when it measurably helps; design tools like prompts (clear boundaries, examples, poka-yoke); show planning steps. | Agents cost more and compound errors, so they need sandboxes and guardrails; many apps need only one well-built call with retrieval. | [anthropic.com/engineering/building-effective-agents](https://www.anthropic.com/engineering/building-effective-agents) — **read** |
| LangGraph | Graph runtime, MIT. Lists durable execution (resume where it left off), human-in-the-loop (inspect and change state), short- and long-term memory, tracing through its hosted tool, deployment. | Checkpointed state per step makes pause, resume and replay normal. | Secondary comparisons call it the most mature for checkpoint and replay (search only); it adds a graph model to learn. | [github.com/langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) — **read** |
| Microsoft Agent Framework | Python and C#, MIT. Graph workflows with sequential, concurrent, handoff and group-collaboration patterns, streaming, time-travel, checkpointing and human-in-the-loop listed, built-in OpenTelemetry. | Same patterns as above with .NET parity and standard tracing. | README gives no checkpoint detail. The older AutoGen is archived: no fixes, no security fixes. | [github.com/microsoft/agent-framework](https://github.com/microsoft/agent-framework), [github.com/microsoft/autogen](https://github.com/microsoft/autogen) — **read** |
| CrewAI | Python, MIT. Crews (role-based teams) and Flows (event-driven, state, branching), tools, memory, knowledge, checkpointing, MCP and A2A. | Easiest start; Flows add deterministic control. | Role-play teams are the weakest fit when a task is not naturally split by role. | [github.com/crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) — **read** |
| Google ADK | Apache-2.0. Graph Workflow runtime (routing, fan-out and fan-in, loops, retries, state, human-in-the-loop, nested), Task API for agent delegation, hierarchies, tools (built-in, OpenAPI, MCP) with a confirmation flow, `adk eval`, Gemini-optimised but model-agnostic. | Evaluation and tool-confirmation are first-class. | Cloud deployment paths lean on Google services. | [github.com/google/adk-python](https://github.com/google/adk-python) — **read** |
| Model Context Protocol | Open protocol for tools, resources and prompts. The spec repo is MIT; the schema is versioned by date. The latest revision seen in secondary sources is 2025-11-25 (OpenID discovery, incremental scope consent, experimental tasks, updated security guidance). | One tool surface for any client; consent is the implementer's job (the spec says it cannot enforce security itself). | The repo snapshot read here is dated `2026-07-28`, newer than the secondary sources: the changelog page itself was blocked, so FRIDAY's pinned MCP version must be checked against the live spec before any change. | [github.com/modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol) — **read**; changelog — **blocked** |

### 1.2 Model families

| Family | Facts read | Use for FRIDAY | Source, access |
| --- | --- | --- | --- |
| Anthropic Claude | Manual extended thinking (`budget_tokens`, minimum 1,024, must be below `max_tokens`) is **deprecated**: Claude 4.7 and later reject it with a 400 error and use **adaptive thinking** with an `effort` setting. Thinking blocks must be preserved across tool turns on newer models, and changing the thinking setting invalidates prompt caching. | FRIDAY must not hard-code a thinking budget. A provider adapter should pass effort, not tokens, for adaptive models and read the capability from the model record. | [platform.claude.com extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) — **read** |
| Qwen3 | Dense 0.6B–32B and MoE 30B-A3B, 235B-A22B, Apache-2.0. Thinking on by default (`enable_thinking=False` or `/no_think` to switch off); 2507 releases split into Instruct (no thinking) and Thinking; 256K context, extendable to 1M. Warns that SGLang and vLLM drop `reasoning_content`, which can hurt multi-step tool use with thinking models. | Local-first workhorse family. FRIDAY must keep reasoning content across tool turns for these models. | [github.com/QwenLM/Qwen3](https://github.com/QwenLM/Qwen3) — **read** |
| DeepSeek-R1 | 671B total, 37B active, 128K context, MIT. R1-Zero is pure RL; R1 adds cold-start data and two RL and two SFT stages; six distilled dense models (1.5B–70B) on Qwen2.5 and Llama. Recommends temperature 0.5–0.7, no system prompt, and forcing a `<think>` start because models sometimes skip thinking. | Distilled R1 models are practical local reasoners; usage rules differ from chat models, so profiles must be per model. | [github.com/deepseek-ai/DeepSeek-R1](https://github.com/deepseek-ai/DeepSeek-R1) — **read** |
| Meta Llama | Table of Llama 2, 3, 3.1 (up to 405B, 128K), 3.2 (1B, 3B, vision 11B and 90B), 3.3 (70B), Llama 4 Scout and Maverick (10M and 1M context). Weights are "licensed for researchers and commercial entities" under a per-model licence and use policy that the README does not quote. | Read each model's licence before bundling or recommending it; do not assume permissive terms. | [github.com/meta-llama/llama-models](https://github.com/meta-llama/llama-models) — **read** |
| Mistral | The inference library is Apache-2.0 and now archived. Listed open weights include Mistral 7B, Mixtral, NeMo, Pixtral, Small 3.1. Codestral 22B and Mistral Large 2 carry non-commercial licences. All listed models support function calling. | Same rule: licence per model. | [github.com/mistralai/mistral-inference](https://github.com/mistralai/mistral-inference) — **read** |
| Google Gemini | Gemini is the ADK's optimised model. The long-context and thinking settings were **not** established by this research. | Treat Gemini claims about context and thinking as unverified until its model docs can be read. | ADK README — read; Gemini model pages — **not read** |

### 1.3 Memory, retrieval, routing and evaluation

| Topic | Facts | Use for FRIDAY | Source, access |
| --- | --- | --- | --- |
| Letta (MemGPT) | Platform for stateful agents with memory that persists across sessions, Apache-2.0. The README does not describe the memory tiers; the MemGPT paper (virtual context management) could not be read. | Idea only (paging memory in and out of context); FRIDAY's six-tier memory already does tiered retention. | [github.com/letta-ai/letta](https://github.com/letta-ai/letta) — **read**; MemGPT paper — **blocked** |
| Mem0 | Memory layer: user, session and agent memory; single-pass add-only extraction; entity linking; semantic plus BM25 plus entity retrieval fused in parallel; time-aware ranking. Vendor-reported LoCoMo 92.5 and LongMemEval 94.4 on its **managed** platform, "may differ" for open source. | Multi-signal retrieval with temporal ranking is the useful pattern. The numbers are the vendor's claim and are not used. | [github.com/mem0ai/mem0](https://github.com/mem0ai/mem0) — **read** |
| Rerankers | Sentence-Transformers (Apache-2.0) offers embedding models and cross-encoders ("rerankers") that score a query and passage together; a retrieve-then-rerank example is linked. | A small cross-encoder as an optional second stage over the top candidates. | [github.com/UKPLab/sentence-transformers](https://github.com/UKPLab/sentence-transformers) — **read** |
| Agent-paper index | Lists memory papers (MIRIX, Mem0, A-MEM, MemoryBank), planning (Plan-and-Act, MPO, AdaPlanner), reflection and self-improvement (Self-Refine, Recursive Introspection). | Reading list only; none adopted from the title alone. | [github.com/AGI-Edgerunners/LLM-Agents-Papers](https://github.com/AGI-Edgerunners/LLM-Agents-Papers) — **read** (first 100K characters) |
| Reflexion and Self-Refine | Retry with written feedback from an evaluator. Summaries note Reflexion fell below baseline on MBPP when the evaluator was self-written unit tests that gave false positives. | The evaluator must be reliable and deterministic. Already adopted in the answer loop. | Search summaries — **search only**; paper — blocked |
| Routing and cascades | A 2026 survey, agreement-based cascading and a Stanford review argue that verifying an answer beats predicting the best model, that self-reported confidence is unreliable, and that learned routers can fall to random-baseline level on some benchmarks. | Escalate on deterministic checks. No learned router. | Search summaries — **search only** |
| Mixture-of-Agents | Layered proposers and an aggregator beat a ranker in the original paper; a later paper reports that mixing only the single best model (Self-MoA) can beat mixing different models. | Use several models only where an objective verifier chooses; mixing for its own sake is unproven. | Search summaries — **search only** |
| SWE-bench | Real GitHub issues; the model writes a patch; Docker harness. Verified is a 500-problem human-confirmed subset. Needs about 120 GB free, 16 GB RAM, 8 cores; arm64 experimental. | Too heavy to run on the owner's PC. A small local task set that runs real tests is the right shape. | [github.com/SWE-bench/SWE-bench](https://github.com/SWE-bench/SWE-bench) — **read** |
| τ-bench | Multi-turn tool-agent-user conversations with domain APIs and policy rules; leaderboard reports Pass^1 to Pass^4 and shows scores dropping as k rises (for example 0.460 to 0.225 on one entry). Its error tool labels failures by who is at fault and by type (wrong tool, wrong argument, unintended action). The page itself says its tasks are outdated. | Adopt the idea: measure reliability across repeated runs, and classify failures by fault and type. |  [github.com/sierra-research/tau-bench](https://github.com/sierra-research/tau-bench) — **read** |
| Agent extended thinking and tool use | Anthropic notes interleaved thinking lets the model reason between tool calls (adaptive mode does this automatically). | Pass-through at the provider layer, not an FRIDAY reimplementation. | Claude docs — **read** |

## 2. What the world's best systems share

1. **A small number of primitives**: an agent, a tool, a handoff or delegation, a guardrail, a session, a trace. Complexity is added only when it is measured to help (Anthropic, OpenAI).
2. **Durable state**: every step is checkpointed so a run can pause, be inspected by a person, and resume (LangGraph, ADK, Microsoft Agent Framework).
3. **Tracing as a default**, not a debug mode (OpenAI, Microsoft with OpenTelemetry).
4. **Evaluation in the box**: ADK ships `adk eval`; τ-bench and SWE-bench exist because without a fixed task set no change can be called an improvement.
5. **Deterministic verification** where one exists (tests, schemas, parsers), model judgement only where none does.
6. **Memory with time**: retrieval that mixes meaning, keywords and entities, ranks by recency for current-state questions, and keeps history (Mem0).
7. **Provider-specific reasoning controls** that change every few months (Claude's move from a token budget to adaptive thinking with effort), so the integration layer, not the application, must absorb them.

## 3. What FRIDAY lacks, in one list

These are the findings that the rest of the documents act on. Each is traced to the repository in the gap analysis.

1. Provider reasoning controls are not passed through: no adaptive-thinking effort, no `enable_thinking`, no reasoning-effort field is sent from anywhere in `electron/`, `kernel/` or `src/` (searched for `enable_thinking`, `reasoning_effort`, `budget_tokens`, `thinking_budget` and `effort`; none found).
2. No per-model measured quality, latency and cost profile; the capability matrix is per domain for FRIDAY overall, and routing statistics are per task kind and model but are not shown or used for cost-quality trade-offs.
3. Retrieval is a hashed n-gram index or Chroma, with query expansion and fusion in TypeScript, but no reranker and no entity or temporal signal in the vector path.
4. Agents plan and inspect; they mutate only after approval. There is no shared context between agents beyond the ledger, no agent message passing, and only the new "at the same time" node runs pieces concurrently.
5. The streaming chat and Auto mode make one model call; the check-fix-escalate loop is not on them.
6. The offline evaluation has no long-horizon, tool-selection, routing-quality, cost, latency or pass-k reliability measures.
7. No A2A, no agent-card style capability description for outside agents. MCP is present and off by default.
8. `kernel/finetune_lora.py` has no direct test; local adapter training is therefore unverified on this machine.

## 4. Recommendations in priority order

| Priority | Recommendation | Why | Source basis |
| --- | --- | --- | --- |
| 1 | A provider reasoning adapter: per-model record says which control it takes (effort, enable_thinking, budget, none), the router sends it, and reasoning content is kept across tool turns. | Claude's budget is already rejected by newer models; Qwen3 serving can drop reasoning content. | Claude docs, Qwen3 README (read) |
| 2 | Put the existing check-fix-escalate loop on the streaming chat and Auto mode, with a visible "checked" note. | It is built and tested; only wiring is missing. | Anthropic guide, Reflexion caveat |
| 3 | Per-model measured profile (pass rate on FRIDAY's own fixed tasks, latency, cost), fed by the Compare run and real turns, used by routing and shown on Models. | Routing on measured outcomes beats routing on names; learned routers are unproven. | Routing survey (search only), τ-bench idea |
| 4 | Pass-k reliability and fault-labelled failures in the evaluation harness. | A single pass hides unreliability. | τ-bench (read) |
| 5 | Retrieval upgrade: entity and recency signals in fusion, optional local cross-encoder rerank. | The pattern that Mem0 and sentence-transformers document. | Mem0, sentence-transformers (read) |
| 6 | Agent supervision upgrades: shared task context, explicit handoff versus agent-as-tool, per-step trace and checkpoint (extend `task-graph.ts`, do not add a framework). | The common primitives across LangGraph, OpenAI, ADK. | READMEs (read) |
| 7 | Trace export in OpenTelemetry shape from the existing turn trace. | Standard tooling can then read it. | Microsoft Agent Framework (read) |
| 8 | MCP revision check and tasks support review once `modelcontextprotocol.io` can be read. | The spec has moved. | MCP repo (read), changelog (blocked) |

## 5. What is deliberately not adopted

- **A new agent framework** (LangGraph, CrewAI, ADK, Microsoft Agent Framework, OpenAI Agents SDK). Each solves a problem FRIDAY's `task-graph.ts`, `agent-scheduler.ts` and governance already solve, would be a second runtime, and none is built for approval-gated local Windows control. Their patterns are adopted, their code is not.
- **AutoGen**: archived by its maintainer.
- **Learned routers** such as RouteLLM: the sources reviewed report weak generalisation.
- **Vendor memory benchmarks as claims** about FRIDAY.
- **Cloning another model's abilities.** Weights, private training data and hidden reasoning cannot be transferred. FRIDAY builds adapters (a common interface, a capability profile per model), not copies.
- **Anything needing SWE-bench-scale hardware** on the owner's PC.

## 6. Limits of this research

- Five official hosts were unreachable, so MCP's current changelog, the OpenAI docs site, Google's ADK site, LangGraph's docs site and every arXiv paper were not read. Statements from those are marked search only.
- No number here was reproduced by FRIDAY. The rule in the evaluation plan stands: no claim of being smarter than any model without a measured number from FRIDAY's own harness on the owner's own models.
- Model names, context sizes and licences change; the profile records in the registry, not this document, are the live source.
