# Hybrid Retrieval and Reranking

## Purpose
Combine lexical, dense semantic, metadata, recency and graph retrieval. Rerank candidates before context assembly. Retrieval should optimize usefulness, not maximize result count.

## Canonical flow
Query understanding → filters → lexical/dense/graph retrieval → dedupe → rerank → freshness/security filter → context slice.

## Required contracts
Record retrieval strategy, candidate source, score components and final inclusion reason for evaluation.

## Failure and recovery
If an index is unavailable, use bounded fallback retrieval; do not silently fabricate memory.

## Implementation guidance
Use existing vector-index/retrieval/knowledge graph and introduce a single retrieval contract.
