# FRIDAY Self-Operating System — Master Architecture

## The five planes

### 1. Autonomy Plane
Decides **when** FRIDAY may act without a prompt.

### 2. Learning Plane
Decides **what FRIDAY should remember or update from experience**.

### 3. Growth Plane
Decides **what capability should be improved next**.

### 4. Development Plane
Creates new skills/tools/workflows/agents/modules and safer versions of existing ones.

### 5. Evolution Plane
Runs controlled experiments over candidate prompts, workflows, policies, skills, tools, agents, adapters and code. It keeps an archive of variants and only promotes verified winners.

## Shared kernel
All five planes use:
- Experience Store
- Capability Graph
- Goal/Need Manager
- Evaluator Registry
- Experiment Runner
- Sandbox
- Governance / Promotion Gate
- Artifact Registry
- Version + lineage store
- Rollback manager
- Resource/compute budget
- Model/provider router
- Event bus

## Hot path vs background

**Hot path:** solve the user's task; learn only what can be safely learned immediately.

**Background path:** analyze failures, build curriculum, run evals, propose improvements, conduct experiments, update non-critical artifacts.

**Lab path:** high-cost or high-impact evolution in isolated workspaces. No direct production mutation.

## Improvement hierarchy

1. Context selection / retrieval
2. Memory organization
3. Prompt/instruction refinement
4. Tool parameters
5. Workflow topology
6. Skill implementation
7. Agent decomposition
8. Routing policy
9. Local adapter / LoRA
10. Production code changes
11. Base-model retraining (external/explicit project)

The system should prefer the lowest-cost change that can explain and fix the observed failure.

## Central loop
`Observe → Diagnose → Hypothesize → Generate Candidate → Sandbox → Evaluate → Compare → Promote/Reject → Monitor → Learn`
