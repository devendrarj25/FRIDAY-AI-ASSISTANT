# FRIDAY — Autonomy / Self-Learning / Self-Growth / Self-Development / Self-Evolution Upgrade

## Purpose
This package is an implementation blueprint for upgrading the **existing FRIDAY project**, not a generic green-field agent framework.

It covers only the self-* section:
- autonomy
- self-learning
- self-growth
- self-development
- self-evolution
- evaluation / verification
- controlled self-modification
- capability growth
- experience and memory loops
- safe background operation

It deliberately does **not** replace the already-built Models/Providers/Router section. It integrates with that section as the intelligence substrate.

## Core design rule
FRIDAY should become increasingly capable over time without turning production into an uncontrolled recursive self-modification loop.

The target is:

`Observe → Remember → Evaluate → Learn → Propose → Experiment → Verify → Promote → Monitor → Rollback → Learn again`

Higher-risk changes move from runtime hot-path to an isolated improvement lab. Production only receives changes that pass explicit promotion gates.

## Package contents
Read the numbered folders in this order. The old byte-size listing was removed; the repository is the source list.

| Folder | Plan |
|---|---|
| `00_MASTER` | Read-first and boundaries |
| `01_CURRENT_STATE` | Integration map and what already exists |
| `02_ARCHITECTURE` | Self operating system |
| `03_AUTONOMY` | Policy and delegation |
| `04_SELF_LEARNING` | Learning loop |
| `05_SELF_GROWTH` | Curriculum |
| `06_SELF_DEVELOPMENT` | Tool, skill, and workflow forge |
| `07_SELF_EVOLUTION` | Evolution lab |
| `08_MEMORY_EXPERIENCE` | Experience and memory |
| `09_EVALUATION` | Evaluation and regression |
| `10_SAFETY_GOVERNANCE` | Governance, safety, rollback |
| `11_IMPLEMENTATION` | Phases and the current-file map |
| `12_UI` | Surfaces for this plan |
| `13_RESEARCH` | Research synthesis |
| `14_SCHEMAS` | Durable-record schemas |
| `15_DIAGRAMS` | Flow diagrams |
| `16_AGENT_HANDOFF` | Implementation notes for this package |

## Important boundary
"Self-evolution" here means **bounded, evidence-driven improvement of FRIDAY's behavior, workflows, skills, tools, routing policies and — only after stronger gates — local adapters/code**. It does not authorize unrestricted self-replication, credential acquisition, security bypass, disabling safety controls, or unreviewed changes to protected governance code.
