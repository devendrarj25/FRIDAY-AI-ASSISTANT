# PROGRESSIVE DISCOVERY PROTOCOL

The model should not receive hundreds of tool schemas.

## Card
id, title, tags, one-line description, inputs/outputs summary, readiness, risk.

## Search
Query by intent, artifact type, platform, domain and constraints.

## Candidate hydration
Load full schema for top candidates only.

## Composition hydration
Load implementation notes only for selected nodes.

## Runtime
The execution engine—not the model—enforces permissions and validates arguments.

## Cache
Cache capability cards and evidence fingerprints, but invalidate on version/schema/
dependency/policy/environment changes.
