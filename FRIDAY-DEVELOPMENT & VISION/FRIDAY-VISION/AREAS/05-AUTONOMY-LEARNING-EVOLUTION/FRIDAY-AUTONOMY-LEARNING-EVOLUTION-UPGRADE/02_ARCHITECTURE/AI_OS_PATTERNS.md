# AI-OS / Agent-System Patterns Synthesized for FRIDAY

## AIOS pattern
AIOS treats LLM agents like processes/resources and introduces scheduling, context switching, memory, storage, tool and SDK management. FRIDAY should borrow the **resource/kernel separation**, not copy the whole project.

## MemGPT/Letta pattern
Treat memory as an actively managed hierarchy. Agents can edit persistent memory blocks and retrieve long-term state. FRIDAY already has memory tiers; the upgrade adds a memory write policy and provenance rather than giving the model unrestricted writes.

## Voyager pattern
Three ideas are directly useful:
1. automatic curriculum
2. executable skill library
3. iterative feedback/error/self-verification

FRIDAY should apply these to real desktop/project tasks, but with sandboxing and permissions.

## Reflexion / Self-Refine pattern
Use verbal feedback/reflection as a learning artifact, but never treat reflection alone as proof. A reflection becomes durable only when linked to an evaluator result or explicit owner correction.

## SWE-agent / OpenHands pattern
Long-horizon development needs an environment, tools, checkpoints and real verification. FRIDAY's dev pipeline should run candidate changes in isolated workspaces with tests before promotion.

## DSPy / MIPRO / GEPA pattern
Prompt and workflow components can be optimized against a metric without changing model weights. FRIDAY should use this as the first evolution layer because it is cheap, interpretable and reversible.

## AFlow / ADAS pattern
Workflow topology itself can be searched. FRIDAY should represent workflows as versioned graphs and allow controlled mutation/search over them.

## AlphaEvolve pattern
Use executable evaluators as the objective function. A candidate is valuable only if it measurably improves a real metric.

## Darwin Gödel Machine / Hyperagents pattern
Population-based self-modification and meta-level improvement are powerful research ideas. FRIDAY should implement a **bounded Evolution Lab** inspired by them, not an unrestricted recursive self-edit loop. Candidates live in branches/sandboxes; production promotion is a separate gated action.

## AI Scientist-v2 pattern
Tree search over hypotheses/experiments is useful for research and development. FRIDAY should use bounded experiment budgets and sandboxed code execution.

## LangMem / Graphiti pattern
Background memory extraction and temporal/provenance-aware context graphs are useful. FRIDAY should retain source/time validity and allow facts to be superseded instead of silently overwritten.
