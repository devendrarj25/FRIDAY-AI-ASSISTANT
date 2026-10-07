# Deep Research Synthesis — Self-Learning / Self-Evolving AI

## 1. AIOS — agent operating system
AIOS separates scheduling, context switching, memory, storage and tool management at the operating-system level. Lesson for FRIDAY: self-improvement should be a kernel service, not scattered inside every agent.

## 2. Letta / MemGPT
Stateful agents can manage long-term memory and context themselves. Lesson: memory needs explicit hierarchy, write rules and retrieval policy.

## 3. Voyager
Automatic curriculum + executable skill library + iterative error/self-verification. Lesson: growth should create reusable procedures and increase difficulty based on measured competence.

## 4. Reflexion / Self-Refine
Language feedback can improve the next attempt. Lesson: reflection is a learning signal, not proof; attach it to verification.

## 5. SWE-agent / OpenHands
Long-horizon development benefits from real environments, tool loops and verification. Lesson: FRIDAY's self-development needs isolated workspaces and checkpoints.

## 6. DSPy / MIPRO / GEPA
Prompt/program components can be optimized against metrics. Lesson: optimize prompts/workflows before expensive model training. GEPA's reflective Pareto evolution is particularly useful for modular FRIDAY instructions.

## 7. AFlow / ADAS
Workflow topology can be searched and generated. Lesson: FRIDAY should treat workflow structure as an evolvable artifact.

## 8. AlphaEvolve
LLM-generated algorithm variants are evaluated by executable objectives. Lesson: self-improvement needs objective evaluators, not self-opinion.

## 9. AI Scientist-v2
Agentic tree search can generate hypotheses, run experiments and write results. Lesson: research-style self-development can use bounded experiment trees.

## 10. Darwin Gödel Machine
Self-modifying agents can maintain an archive of variants and empirically validate improvements. Lesson: FRIDAY can use a population/archive architecture, but must keep production promotion separate and gated.

## 11. Hyperagents
Meta-level mechanisms can themselves be editable. Lesson: the evolution mechanism can become an object of evolution, but only in a separate protected lab with independent evaluation.

## 12. LangMem / Graphiti
Background memory consolidation and temporal context graphs. Lesson: FRIDAY needs provenance, validity intervals and incremental updates.

## 13. Evals
OpenAI Evals and Anthropic's agent-eval guidance reinforce the same principle: complex agents need systematic, lifecycle-spanning evaluation rather than production-only debugging.

## 14. Continual post-training
TRL provides SFT, DPO and GRPO building blocks. Lesson: local training should be an adapter behind a strict dataset/evaluation gate, not the first mechanism used for every improvement.

## Research conclusion
The strongest architecture is not one technique. It is a layered system:
`memory + reflection + curriculum + workflow evolution + executable evaluation + sandbox + archive + promotion gate + rollback`.
