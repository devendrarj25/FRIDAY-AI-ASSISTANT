# Multi-model engine

## Why multi-model is not just voting

Models can have correlated errors. Three providers using the same underlying family are not necessarily three independent opinions.

Therefore FRIDAY tracks diversity across:

- model family
- provider
- runtime
- training lineage when known
- prompt transformation
- decoding configuration

## Execution patterns

### Parallel
Best for independent candidates or fast consensus.

### Primary + critic
One model drafts; a second model looks specifically for errors.

### Primary + verifier
Verifier gets the answer plus a compact task contract and checks correctness.

### Specialist panel
Route subtasks to specialists: coder, researcher, vision, extraction, planner.

### Candidate + judge
Generate N candidates, then use a judge to rank them. The judge must not be the same endpoint when independence matters.

### Pipeline
`planner → retrieval → specialist → synthesizer`

## Aggregation rules

Never concatenate all outputs blindly. The aggregator should receive:

- task contract
- candidate outputs
- evidence/provenance
- disagreement map
- model confidence signals

Then produce one canonical result plus internal disagreement metadata.
