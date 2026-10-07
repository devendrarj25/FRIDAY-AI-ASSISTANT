# Memory OS — Final

Memory is a managed subsystem, not a prompt dump.

## Tiers
1. sensory/transient context;
2. working memory;
3. episodic events and task history;
4. semantic knowledge;
5. procedural skills and successful workflows;
6. preferences and social memory;
7. world-state/temporal graph;
8. system self-knowledge and capability health.

## Rules
- durable memory is external to model context;
- every memory item has provenance, confidence and lifecycle;
- memory retrieval is hybrid: lexical + semantic + graph + temporal + reranking;
- stale facts are down-weighted or revalidated;
- contradictory facts are preserved until resolved;
- sensitive memory is access-controlled and minimised;
- memory writes can be proposed by the agent but policy decides whether they persist;
- procedural/browser memories are reusable but never authoritative over live UI state.

## Experience replay
Completed runs produce compact lessons: what worked, what failed, environmental assumptions, recovery path and verification evidence. Lessons are candidates for future routing and skills, not unquestioned truth.
